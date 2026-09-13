import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ownerPool, createAccount } from '../helpers/database.js';
import { signIn, withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveProduct, listProducts } from '../../src/masters/products.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

const owner=ownerPool();
after(async () => { await closePool();await owner.end(); });
test('Product listing preserves typed search/sort, independent display/filter flags, raw choices and batched date arrays',async () => {
  const account=await createAccount(owner,{permissions:['masters.manage']});
  const session=await signIn({identifier:account.username,password:account.password});
  const work=(action,readOnly=false) => withSession(session.token,action,{csrfToken:session.csrfToken,readOnly});
  const input=(name,customFields) => ({id:randomUUID(),requestId:randomUUID(),revision:0,name,key:name,...(customFields?{customFields}: {})});
  const missing=await work((client,identity) => saveProduct(client,identity,input('Missing')));
  const specifications=[
    {key:'mixed',fieldType:'text',showInList:true,showInFilter:true},
    {key:'choice',fieldType:'select',showInList:true,showInFilter:true,options:[{id:randomUUID(),key:'OPTION_KEY',label:'Selected Label'}]},
    {key:'hidden',fieldType:'text',showInList:false,showInFilter:true},
    {key:'visible',fieldType:'text',showInList:true,showInFilter:false},
    {key:'dates',fieldType:'date',showInList:true,showInFilter:false,allowsMultiple:true},
  ];
  const fields=[];
  for(const specification of specifications) fields.push(await work((client,identity) => saveCustomField(client,identity,{...specification,
    id:randomUUID(),requestId:randomUUID(),revision:0,associatedWith:'product',label:specification.key})));
  const customKey=`pf:${fields[0].id}`;
  const rows=[];
  for(const [name,value] of [['Alpha',0],['Beta',2],['Gamma','0'],['Delta',false],['Epsilon',true],['Zeta','0%_.*\\'],['Eta','A  B']]) {
    const values={mixed:value,choice:name==='Alpha'?'OPTION_KEY':'',hidden:name==='Beta'?'FilterOnlyValue':'',visible:'DisplayOnlyValue',dates:['2026-12-31',0,false]};
    rows.push(await work((client,identity) => saveProduct(client,identity,{...input(name,fields.map((field) => ({fieldId:field.id,fieldRevision:field.revision,value:values[field.key]}))),customFieldTimeZone:'UTC'})));
  }
  const list=(query) => work((client,identity) => listProducts(client,identity,{pageSize:100,...query}),true);
  const ascending=await list({sort:{key:customKey,dir:'asc'}});
  assert.deepEqual(ascending.rows.map((row) => row.name),['Missing','Alpha','Beta','Gamma','Zeta','Eta','Delta','Epsilon']);
  assert.equal(ascending.rows[0]._id,missing.id);
  assert.deepEqual((await list({sort:{key:customKey,dir:'desc'}})).rows.map((row) => row.name),['Epsilon','Delta','Eta','Zeta','Gamma','Beta','Alpha','Missing']);
  assert.deepEqual(new Set((await list({search:'0'})).rows.map((row) => row.name)),new Set(['Alpha','Gamma','Delta','Zeta']));
  assert.deepEqual((await list({search:'%_.*\\'})).rows.map((row) => row.name),['Zeta']);
  assert.deepEqual((await list({search:'FilterOnlyValue'})).rows.map((row) => row.name),['Beta']);
  assert.equal((await list({search:'DisplayOnlyValue'})).totalCount,0);
  assert.deepEqual((await list({search:'OPTION_KEY'})).rows.map((row) => row.name),['Alpha']);
  assert.deepEqual((await list({filters:{[`pf:${fields[1].id}`]:{type:'select',value:'Selected Label'}}})).rows.map((row) => row.name),['Alpha']);
  assert.equal((await list({filters:{[customKey]:{type:'text',value:'A B'}}})).totalCount,0);
  assert.deepEqual((await list({filters:{[customKey]:{type:'text',value:'A  B'}}})).rows.map((row) => row.name),['Eta']);
  await assert.rejects(list({filters:{[`pf:${fields[3].id}`]:{type:'text',value:'DisplayOnlyValue'}}}),{code:'invalid_input'});
  await assert.rejects(list({sort:{key:`pf:${fields[2].id}`,dir:'asc'}}),{code:'invalid_sort'});
  const calls=[];
  const measured=await work((client,identity) => listProducts({query:(sql,args)=>{calls.push(sql);return client.query(sql,args);}},identity,{pageSize:100}),true);
  assert.equal(calls.length,6,'two definition queries, count/page queries and two captured-value batches');
  const alpha=measured.rows.find((row)=>row.name==='Alpha');
  assert.equal(alpha.customFields[fields[0].id].displayValue,0);
  assert.deepEqual(alpha.customFields[fields[4].id].value,['2026-12-31',0,false]);
  assert.equal(Object.hasOwn(alpha.customFields,fields[2].id),false);
  const foreign=await createAccount(owner,{permissions:['masters.read']});
  const other=await signIn({identifier:foreign.username,password:foreign.password});
  assert.deepEqual(await withSession(other.token,(client,identity)=>listProducts(client,identity),{readOnly:true}),{rows:[],totalCount:0});
});
