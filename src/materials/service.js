import { HttpError } from '../auth/errors.js';
import { dateOnly, fieldsOnly, integer, requirePermission, uuid } from '../templates/input.js';
import { canonicalDecimal } from '../datasheets/final-result.js';
import { materialFingerprint, materialInput, materialTransactionInput } from './input.js';

export function requireMaterialRead(identity) {
  if (!identity.permission_codes?.some(permission => ['masters.read', 'masters.manage'].includes(permission))) {
    throw new HttpError(403, 'forbidden', 'You cannot view materials.');
  }
}

export function materialError(error) {
  const errors = {
    material_active_code: [409, 'material_code_exists', 'The unique key is already used by another material.'],
    material_category_available: [422, 'invalid_material_category', 'Select an available material category.'],
    material_unit_available: [422, 'invalid_measurement_unit', 'Select an available unit of measure.'],
    material_amounts: [422, 'invalid_material_quantity', 'Quantities must be nonnegative and maximum cannot be below minimum.'],
    material_transaction_amounts: [422, 'invalid_material_transaction_quantity', 'Quantity must be positive and cost nonnegative, within the supported finite range.'],
    material_initial_below_issued: [422, 'initial_stock_below_issued', 'Initial quantity cannot be below the quantity already issued from initial stock.'],
    material_category_in_use: [409, 'material_category_in_use', 'This category is assigned to one or more materials.'],
    material_duplicate_in_batch: [409, 'material_batch_exists', 'This Batch/Serial No already exists. Enter a unique one.'],
    material_expiry_required: [422, 'invalid_material_expiry', 'Select a valid nonpast expiry date for an expirable material.'],
    material_insufficient_stock: [422, 'insufficient_material_stock', 'OUT quantity cannot exceed available material or selected batch quantity.'],
    material_transaction_available: [404, 'material_not_found', 'Material was not found.'],
    material_transaction_pk: [409, 'material_transaction_exists', 'This transaction identifier was already recorded.'],
    material_transaction_opening_id: [409, 'material_transaction_exists', 'This transaction identifier belongs to opening stock.'],
  };
  const known = errors[error.constraint];
  if (known) return new HttpError(...known);
  return error;
}

export const materialColumns = `material.id,material.revision,material.name,material.code,material.description,material.active,
  material.category_id AS "categoryId",category.name AS "categoryName",category.reusable AS "categoryReusable",category.expirable AS "categoryExpirable",
  material.measurement_unit_id AS "measurementUnitId",unit.name AS "unitName",unit.symbol AS "unitSymbol",
  material.initial_quantity AS "initialQuantity",material.minimum_quantity AS "minimumQuantity",material.maximum_quantity AS "maximumQuantity",
  material.initial_stock_id AS "initialStockId",material.initial_stock_created_at AS "initialStockCreatedAt",material.initial_stock_created_by AS "initialStockCreatedBy",
  material.created_at AS "createdAt",material.created_by AS "createdBy",material.updated_at AS "updatedAt",material.updated_by AS "updatedBy"`;
export const materialJoins = `materials material JOIN material_categories category ON category.organization_id=material.organization_id AND category.id=material.category_id
  JOIN measurement_units unit ON unit.organization_id=material.organization_id AND unit.id=material.measurement_unit_id`;

export async function loadMaterial(client, identity, materialId, { atRevision } = {}) {
  requireMaterialRead(identity); uuid(materialId, 'Material');
  let result;
  if (atRevision !== undefined) {
    integer(atRevision, 'Revision', 1, 2_147_483_647);
    result = await client.query(`SELECT material_id AS id,revision,name,code,description,active,category_id AS "categoryId",category_name AS "categoryName",
      category_reusable AS "categoryReusable",category_expirable AS "categoryExpirable",measurement_unit_id AS "measurementUnitId",unit_name AS "unitName",unit_symbol AS "unitSymbol",
      initial_quantity AS "initialQuantity",minimum_quantity AS "minimumQuantity",maximum_quantity AS "maximumQuantity",maximum_provided AS "maximumProvided",
      initial_stock_id AS "initialStockId",initial_stock_created_at AS "initialStockCreatedAt",initial_stock_created_by AS "initialStockCreatedBy",
      request_id AS "requestId",previous_revision AS "previousRevision",operation,saved_by AS "savedBy",saved_at AS "savedAt"
      FROM material_versions WHERE organization_id=$1 AND material_id=$2 AND revision=$3`, [identity.organization_id, materialId, atRevision]);
  } else {
    result = await client.query(`SELECT ${materialColumns},material.initial_quantity+coalesce(stock.quantity,0) AS "currentQuantity"
      FROM ${materialJoins} LEFT JOIN LATERAL(SELECT sum(CASE WHEN transaction_type='in' THEN quantity ELSE -quantity END) AS quantity
        FROM material_transactions WHERE organization_id=material.organization_id AND material_id=material.id) stock ON true
      WHERE material.organization_id=$1 AND material.id=$2 AND material.active`, [identity.organization_id, materialId]);
  }
  if (!result.rowCount) throw new HttpError(404, 'material_not_found', 'Material was not found.');
  return result.rows[0];
}

async function requestLock(client, identity, requestId, kind) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text,0))', [`material-${kind}:${identity.organization_id}:${requestId}`]);
}

async function priorMaterialSave(client, identity, input, operation) {
  await requestLock(client, identity, input.requestId, 'save');
  const prior = (await client.query('SELECT material_id,revision,previous_revision,operation,saved_by FROM material_versions WHERE organization_id=$1 AND request_id=$2', [identity.organization_id, input.requestId])).rows[0];
  if (!prior) return null;
  if (prior.material_id !== input.id || (prior.previous_revision ?? 0) !== input.revision || prior.operation !== operation || prior.saved_by !== identity.user_id) {
    throw new HttpError(409, 'save_request_reused', 'This save request was already used for another change.');
  }
  return loadMaterial(client, identity, input.id, { atRevision: prior.revision });
}

export async function saveMaterial(client, identity, value) {
  requirePermission(identity, 'masters.manage'); const input = materialInput(value);
  await client.query('SELECT masters_lock_field_writer()');
  const provided = Object.hasOwn(input, 'maximumQuantity');
  const prior = await priorMaterialSave(client, identity, input, input.revision ? 'update' : 'create');
  if (prior) {
    if (prior.maximumProvided !== provided || materialFingerprint(prior) !== materialFingerprint({ ...input, maximumQuantity: provided ? input.maximumQuantity : prior.maximumQuantity })) {
      throw new HttpError(409, 'save_request_reused', 'This save request was already used for different values.');
    }
    return prior;
  }
  const current = (await client.query('SELECT revision,active,maximum_quantity FROM materials WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, input.id])).rows[0];
  if (input.revision && !current?.active) throw new HttpError(404, 'material_not_found', 'Material was not found.');
  if ((current?.revision ?? 0) !== input.revision) throw new HttpError(409, 'stale_material', 'The material changed. Reload before saving.');
  const args = [identity.organization_id, input.id, input.name, input.code, input.description, input.categoryId, input.measurementUnitId,
    input.initialQuantity, input.minimumQuantity, provided ? input.maximumQuantity : current?.maximum_quantity ?? null, input.requestId, identity.user_id, provided];
  try {
    if (!input.revision) await client.query(`INSERT INTO materials(organization_id,id,name,code,description,category_id,measurement_unit_id,
      initial_quantity,minimum_quantity,maximum_quantity,save_request_id,created_by,updated_by,maximum_provided) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13)`, args);
    else await client.query(`UPDATE materials SET name=$3,code=$4,description=$5,category_id=$6,measurement_unit_id=$7,
      initial_quantity=$8,minimum_quantity=$9,maximum_quantity=$10,save_request_id=$11,updated_by=$12,maximum_provided=$13,
      revision=revision+1,updated_at=transaction_timestamp() WHERE organization_id=$1 AND id=$2`, args);
  } catch (error) { throw materialError(error); }
  return loadMaterial(client, identity, input.id);
}

export async function retireMaterial(client, identity, value) {
  requirePermission(identity, 'masters.manage'); fieldsOnly(value, ['id', 'requestId', 'revision']);
  const input = { id: uuid(value.id, 'Material').toLowerCase(), requestId: uuid(value.requestId, 'Delete request').toLowerCase(), revision: integer(value.revision, 'Revision', 1, 2_147_483_646) };
  await client.query('SELECT masters_lock_field_writer()');
  const prior = await priorMaterialSave(client, identity, input, 'retire');
  if (prior) return { id: input.id, revision: prior.revision };
  const current = (await client.query('SELECT revision,active FROM materials WHERE organization_id=$1 AND id=$2 FOR UPDATE', [identity.organization_id, input.id])).rows[0];
  if (!current?.active) throw new HttpError(404, 'material_not_found', 'Material was not found.');
  if (current.revision !== input.revision) throw new HttpError(409, 'stale_material', 'The material changed. Reload before deleting.');
  await client.query(`UPDATE materials SET active=false,revision=revision+1,save_request_id=$3,updated_by=$4,updated_at=transaction_timestamp()
    WHERE organization_id=$1 AND id=$2`, [identity.organization_id, input.id, input.requestId, identity.user_id]);
  return { id: input.id, revision: input.revision + 1 };
}

export const transactionColumns = `id,material_id AS "materialId",request_id AS "requestId",transaction_type AS type,quantity,cost,supplier,batch_serial_number AS "batchSerialNumber",
  expiry_date::text AS "expiryDate",measurement_unit_id AS "measurementUnitId",unit_name AS "unitName",unit_symbol AS "unitSymbol",category_expirable AS "categoryExpirable",created_by AS "createdBy",created_at AS "createdAt"`;

export async function loadMaterialTransaction(client, identity, transactionId) {
  requireMaterialRead(identity); uuid(transactionId, 'Transaction');
  const result = await client.query(`SELECT ${transactionColumns} FROM material_transactions WHERE organization_id=$1 AND id=$2`, [identity.organization_id, transactionId]);
  if (!result.rowCount) throw new HttpError(404, 'material_transaction_not_found', 'Transaction was not found.');
  return result.rows[0];
}

function transactionFingerprint(input, expirable) {
  return JSON.stringify({ type: input.type, quantity: canonicalDecimal(input.quantity), cost: input.type === 'in' ? canonicalDecimal(input.cost) : null,
    batchSerialNumber: input.batchSerialNumber, supplier: input.type === 'in' ? input.supplier : '', expiryDate: input.type === 'in' && expirable ? dateOnly(input.expiryDate) : null });
}

export async function createMaterialTransaction(client, identity, value) {
  requirePermission(identity, 'masters.manage'); const input = materialTransactionInput(value);
  await client.query('SELECT masters_lock_field_writer()'); await requestLock(client, identity, input.requestId, 'transaction');
  const prior = (await client.query(`SELECT ${transactionColumns} FROM material_transactions WHERE organization_id=$1 AND request_id=$2`, [identity.organization_id, input.requestId])).rows[0];
  if (prior) {
    if (prior.id !== input.id || prior.materialId !== input.materialId || prior.createdBy !== identity.user_id
      || transactionFingerprint(prior, prior.categoryExpirable) !== transactionFingerprint(input, prior.categoryExpirable)) {
      throw new HttpError(409, 'save_request_reused', 'This save request was already used for another transaction.');
    }
    return prior;
  }
  const result = await client.query(`SELECT ${materialColumns} FROM ${materialJoins} WHERE material.organization_id=$1 AND material.id=$2 AND material.active FOR UPDATE OF material`, [identity.organization_id, input.materialId]);
  const material = result.rows[0];
  if (!material) throw new HttpError(404, 'material_not_found', 'Material was not found.');
  const expiryDate = input.type === 'in' && material.categoryExpirable ? dateOnly(input.expiryDate) : null;
  let supplier = input.supplier;
  if (input.type !== 'in') {
    const receipt = await client.query(`SELECT supplier FROM (
      SELECT supplier,created_at,id FROM material_transactions WHERE organization_id=$1 AND material_id=$2 AND transaction_type='in' AND batch_serial_number=$3 AND supplier<>''
      UNION ALL SELECT 'Initial Stock',initial_stock_created_at,initial_stock_id FROM materials WHERE organization_id=$1 AND id=$2 AND initial_quantity>0 AND $3='Initial Stock'
      ) receipts ORDER BY created_at,id LIMIT 1`, [identity.organization_id, input.materialId, input.batchSerialNumber]);
    supplier = receipt.rows[0]?.supplier ?? '';
  }
  try {
    await client.query(`INSERT INTO material_transactions(organization_id,id,material_id,request_id,transaction_type,quantity,cost,supplier,batch_serial_number,expiry_date,
      measurement_unit_id,unit_name,unit_symbol,category_expirable,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [identity.organization_id, input.id, input.materialId, input.requestId, input.type, input.quantity, input.cost, supplier, input.batchSerialNumber, expiryDate,
      material.measurementUnitId, material.unitName, material.unitSymbol, material.categoryExpirable, identity.user_id]);
  } catch (error) { throw materialError(error); }
  return loadMaterialTransaction(client, identity, input.id);
}
