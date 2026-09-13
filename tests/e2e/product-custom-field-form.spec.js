import { test,expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { ownerPool,createAccount } from '../helpers/database.js';
import { signIn,withSession } from '../../src/auth/service.js';
import { closePool } from '../../src/db/pool.js';
import { saveCustomField } from '../../src/masters/custom-fields.js';

test.use({timezoneId:'America/New_York'});
let owner;
test.beforeAll(()=>{owner=ownerPool();});
test.afterAll(async()=>{await closePool();await owner.end();});
async function login(page,user) {
  await page.goto('/login');await page.getByLabel('Username',{exact:true}).fill(user.username);
  await page.getByLabel('Password',{exact:true}).fill(user.password);await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page).toHaveURL(/\/me$/);
}
async function fixture() {
  const user=await createAccount(owner,{permissions:['masters.manage','settings.manage']});
  await owner.query("UPDATE users SET display_name='Synthetic_Analyst' WHERE id=$1",[user.userId]);
  const session=await signIn({identifier:user.username,password:user.password});
  const options=[{id:randomUUID(),key:'A',label:'Alpha'},{id:randomUUID(),key:'0',label:'Zero'},{id:randomUUID(),key:'false',label:'False'}];
  const specifications=[
    ['text','Custom Text',{isRequired:true,showInList:true,showInFilter:true}],
    ['number','Custom Number',{}],['date','Custom Date',{showInList:true}],
    ['select','Custom Choice',{options}],['select','Custom Choices',{options,allowsMultiple:true}],
    ['lookup','Custom Lookup',{}],['longtext','Custom Notes',{}],['attachment','Custom Attachment',{}],
    ['multi_user_select','Custom Users',{}],['date_time','Custom Date Time',{showInList:true}],
    ['checkbox','Custom Checkbox',{isRequired:true}],['email','Custom Email',{}],['number','Repeated Number',{allowsMultiple:true}],
    ['text','Manual Code',{scheme:'P/{{scheme_counter}}',splitter:'/',paddedNumber:2,generatedAt:'on_demand',validateUniqueness:true}],
    ['text','Initial Code',{scheme:'I/{{total_counter}}',generatedAt:'on_init'}],
    ['text','Submit Code',{scheme:'{{field_13}}/{{product_name}}',generatedAt:'on_submit'}],
  ];
  const fields=[];
  for(const [index,[fieldType,label,extra]] of specifications.entries()) fields.push(await withSession(session.token,(client,identity)=>saveCustomField(client,identity,
    {id:randomUUID(),requestId:randomUUID(),revision:0,key:`field_${index}`,associatedWith:'product',fieldType,label,displayOrder:index,...extra}),{csrfToken:session.csrfToken}));
  return {user,session,fields};
}

test('Product source controls capture every type, retry lost upload/save responses and retain historical attachment bytes',async({page},testInfo)=>{
  test.setTimeout(90_000);
  const {user,session,fields}=await fixture();await login(page,user);
  await page.goto('/products/new');await expect(page.getByText('Additional Data Fields',{exact:true})).toBeVisible();
  await page.getByLabel('Name',{exact:true}).fill('Synthetic field Product');await page.getByLabel('Unique Key',{exact:true}).fill('SYNTHETIC-FIELDS');
  await page.getByLabel('Custom Text',{exact:true}).fill('Literal %_ value');await page.getByLabel('Custom Number',{exact:true}).fill('0');
  await page.getByLabel('Custom Date',{exact:true}).fill('31122026');await page.getByLabel('Custom Text',{exact:true}).focus();
  await expect(page.getByLabel('Custom Date',{exact:true})).toHaveValue('31/12/2026');
  await expect(page.getByRole('button',{name:'Open calendar',exact:true})).toBeVisible();
  await page.getByLabel('Custom Choice',{exact:true}).selectOption('A');
  await page.getByLabel('Custom Choices',{exact:true}).fill('Zero');await page.getByRole('listbox').getByRole('option',{name:'Zero',exact:true}).click();
  await page.getByLabel('Custom Choices',{exact:true}).fill('False');await page.getByRole('listbox').getByRole('option',{name:'False',exact:true}).click();
  await page.getByLabel('Custom Notes',{exact:true}).fill('Line one\nLine two');
  await page.getByLabel('Custom Users',{exact:true}).fill('Synthetic Analyst');await page.getByRole('listbox').getByRole('option',{name:'Synthetic Analyst',exact:true}).click();
  await page.getByLabel('Custom Date Time',{exact:true}).fill('2026-03-08T02:30');
  await page.getByRole('checkbox',{name:'Custom Checkbox',exact:true}).check();await page.getByRole('checkbox',{name:'Custom Checkbox',exact:true}).uncheck();
  await page.getByLabel('Custom Email',{exact:true}).fill('source permits this text');
  await expect(page.getByRole('textbox',{name:'Repeated Number item 1',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Add Repeated Number item',exact:true}).click();await page.getByRole('textbox',{name:'Repeated Number item 1',exact:true}).fill('invalid');
  await page.getByRole('button',{name:'Add Repeated Number item',exact:true}).click();await page.getByRole('textbox',{name:'Repeated Number item 2',exact:true}).fill('0');
  await page.getByRole('button',{name:'Generate Manual Code value from scheme',exact:true}).click();await expect(page.getByLabel('Manual Code',{exact:true})).toHaveValue('P/001');
  await expect(page.getByLabel('Initial Code',{exact:true})).toHaveValue('');
  const uploadIds=[];let uploaded;
  await page.route('**/api/custom-fields/attachments',async(route)=>{
    uploadIds.push(route.request().headers()['x-upload-request-id']);const response=await route.fetch();expect(response.status()).toBe(201);uploaded=await response.json();
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Synthetic lost upload response'}})});
  });
  await page.getByLabel('Custom Attachment',{exact:true}).setInputFiles({name:`${'synthetic-evidence-'.repeat(20)}.txt`,mimeType:'text/plain',buffer:Buffer.from('Synthetic attachment bytes')});
  await expect(page.getByRole('alert').filter({hasText:'Synthetic lost upload response'})).toBeVisible();await page.unroute('**/api/custom-fields/attachments');
  const retriedUpload=page.waitForResponse((response)=>response.url().endsWith('/api/custom-fields/attachments')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Retry upload',exact:true}).click();const uploadResponse=await retriedUpload;
  expect(uploadResponse.status()).toBe(200);expect(uploadResponse.request().headers()['x-upload-request-id']).toBe(uploadIds[0]);
  await expect(page.getByRole('link',{name:'View File',exact:true})).toBeVisible();expect(await (await page.request.get(uploaded.url)).text()).toBe('Synthetic attachment bytes');
  let saveBody;let saved;
  await page.route('**/api/masters/products',async(route)=>{
    if(route.request().method()!=='POST') return route.continue();
    saveBody=route.request().postDataJSON();const response=await route.fetch();expect(response.status()).toBe(200);saved=await response.json();
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Synthetic lost Product response'}})});
  });
  await page.getByRole('button',{name:'Create',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'Synthetic lost Product response'})).toBeVisible();
  await expect(page.getByLabel('Initial Code',{exact:true})).toHaveValue('I/1');await expect(page.getByLabel('Submit Code',{exact:true})).toHaveValue('P/001/Synthetic field Product');
  await withSession(session.token,(client,identity)=>saveCustomField(client,identity,{id:fields[0].id,requestId:randomUUID(),revision:1,
    key:fields[0].key,label:fields[0].label,fieldType:'text',associatedWith:'product',description:'Definition edited after a lost Product response',
    isRequired:true,showInList:true,showInFilter:true,displayOrder:0}),{csrfToken:session.csrfToken});
  await page.screenshot({path:testInfo.outputPath('product-source-custom-fields-desktop.png'),fullPage:true,animations:'disabled'});
  await page.unroute('**/api/masters/products');
  const retriedSave=page.waitForResponse((response)=>response.url().endsWith('/api/masters/products')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Create',exact:true}).click();const saveResponse=await retriedSave;
  expect(saveResponse.status()).toBe(200);expect(saveResponse.request().postDataJSON()).toEqual(saveBody);await expect(page).toHaveURL(/\/products$/);
  const byLabel=new Map(saved.customFields.map((field)=>[field.label,field]));
  expect(byLabel.get('Custom Number').value).toBe('0');expect(byLabel.get('Custom Checkbox').value).toBe(false);
  expect(byLabel.get('Custom Choices').value).toEqual(['0','false']);expect(byLabel.get('Custom Date').value).toBe('31/12/2026');
  expect(byLabel.get('Custom Date Time').displayValue).toBe('08/03/2026 03:30:00');expect(byLabel.get('Custom Date Time').timeZone).toBe('America/New_York');
  expect(byLabel.get('Repeated Number').items.map((item)=>item.interpretationState)).toEqual(['invalid','valid']);
  expect(byLabel.get('Custom Users').value).toEqual([user.userId]);expect(byLabel.get('Custom Attachment').value).toBe(uploaded.id);
  await expect(page.getByRole('columnheader',{name:'Custom Text',exact:true})).toBeVisible();
  await page.getByPlaceholder('Search...',{exact:true}).fill('%_');await expect(page.getByRole('cell',{name:'Synthetic field Product',exact:true})).toBeVisible();
  await page.goto(`/products/${saved.id}/edit`);await expect(page.getByLabel('Custom Text',{exact:true})).toHaveValue('Literal %_ value');
  await expect(page.getByLabel('Custom Date',{exact:true})).toHaveValue('31/12/2026');await expect(page.getByLabel('Custom Date Time',{exact:true})).toHaveValue('2026-03-08T02:30');
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  const attachmentField=page.locator('.smplfy-form-field').filter({has:page.getByLabel('Custom Attachment',{exact:true})});
  await page.getByRole('link',{name:'View File',exact:true}).scrollIntoViewIfNeeded();
  expect(await attachmentField.evaluate((element)=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('product-long-attachment-mobile.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Remove Custom Attachment file',exact:true}).first().click();await expect(page.getByRole('link',{name:'View File',exact:true})).toHaveCount(0);
  await page.screenshot({path:testInfo.outputPath('product-source-custom-fields-mobile.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('button',{name:'Update',exact:true}).click();await expect(page).toHaveURL(/\/products$/);
  const current=await (await page.request.get(`/api/masters/products/${saved.id}`)).json();
  expect(current.customFields.find((field)=>field.fieldId===fields[7].id).value).toBe('');
  expect(await (await page.request.get(uploaded.url)).text()).toBe('Synthetic attachment bytes');
});

test('Product field-load failures retain the base draft and can be retried before saving',async({page})=>{
  const {user}=await fixture();await login(page,user);
  await page.route('**/api/masters/products/custom-fields',(route)=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'Synthetic field load failure'}})}));
  await page.goto('/products/new');await page.getByLabel('Name',{exact:true}).fill('Retained base draft');
  await expect(page.getByRole('alert').filter({hasText:'Synthetic field load failure'})).toBeVisible();await expect(page.getByRole('button',{name:'Create',exact:true})).toBeDisabled();
  await page.unroute('**/api/masters/products/custom-fields');await page.getByRole('button',{name:'Retry loading fields',exact:true}).click();
  await expect(page.getByText('Additional Data Fields',{exact:true})).toBeVisible();await expect(page.getByLabel('Name',{exact:true})).toHaveValue('Retained base draft');
  await expect(page.getByRole('button',{name:'Create',exact:true})).toBeEnabled();
});

test('source financial-year and Non-NABL scheme settings persist and drive Product generation',async({page})=>{
  const {user,session,fields}=await fixture();
  await withSession(session.token,(client,identity)=>saveCustomField(client,identity,{id:fields[13].id,requestId:randomUUID(),revision:1,
    key:fields[13].key,label:fields[13].label,fieldType:'text',associatedWith:'product',displayOrder:13,
    scheme:'{{financial_year}}/{{current_month}}/{{total_counter}}',generatedAt:'on_demand',paddedNumber:0}),{csrfToken:session.csrfToken});
  await login(page,user);await page.goto('/organization_settings');
  await page.getByRole('tab',{name:'Tenant Settings',exact:true}).click();
  await page.getByLabel('Current Year Digits',{exact:true}).fill('2');await page.getByLabel('Next Year Digits',{exact:true}).fill('4');
  await page.getByLabel('Separator',{exact:true}).fill('~');await page.getByLabel('Current Month Format',{exact:true}).selectOption('number');
  await page.getByRole('tab',{name:'NABL Settings',exact:true}).click();await page.getByLabel('Non-NABL Start Number',{exact:true}).fill('19');
  await page.getByRole('checkbox',{name:'Edit Start No.?',exact:true}).check();
  const response=page.waitForResponse((response)=>response.url().endsWith('/api/organization-settings/laboratory')&&response.request().method()==='PUT');
  await page.getByRole('button',{name:'Save Settings',exact:true}).click();expect((await response).status()).toBe(200);
  await page.reload();await page.getByRole('tab',{name:'Tenant Settings',exact:true}).click();
  await expect(page.getByLabel('Current Year Digits',{exact:true})).toHaveValue('2');await expect(page.getByLabel('Next Year Digits',{exact:true})).toHaveValue('4');
  await expect(page.getByLabel('Separator',{exact:true})).toHaveValue('~');await expect(page.getByLabel('Current Month Format',{exact:true})).toHaveValue('number');
  await page.getByRole('tab',{name:'NABL Settings',exact:true}).click();await expect(page.getByLabel('Non-NABL Start Number',{exact:true})).toHaveValue('19');
  await expect(page.getByRole('checkbox',{name:'Edit Start No.?',exact:true})).not.toBeChecked();
  await page.goto('/products/new');await page.getByRole('button',{name:'Generate Manual Code value from scheme',exact:true}).click();
  const now=new Date();const year=now.getFullYear()-(now.getMonth()<3?1:0);
  await expect(page.getByLabel('Manual Code',{exact:true})).toHaveValue(`${String(year).slice(-2)}~${year+1}/${String(now.getMonth()+1).padStart(2,'0')}/19`);
});
