import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { config } from '../src/config/env.js';
test('M10 additive migration preserves M6–M9 records and constrains service references, assignments, lifecycle dates and warranty decisions', async () => {
  const client = new pg.Client({ connectionString: config.DATABASE_URL }),
    schema = `m10_upgrade_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    const root = new URL('../prisma/migrations/', import.meta.url),
      names = (await readdir(root, { withFileTypes: true }))
        .filter((f) => f.isDirectory())
        .map((f) => f.name)
        .sort();
    for (const name of names.filter((n) => n < '20261005100000'))
      await client.query(
        await readFile(new URL(`${name}/migration.sql`, root), 'utf8'),
      );
    await client.query(`INSERT INTO users(id,email,"displayName",password,"updatedAt") VALUES ('buyer','buyer@example.test','Buyer','fixture',NOW()),('seller','seller@example.test','Seller','fixture',NOW());
 INSERT INTO machine_categories(id,name,slug) VALUES ('category','Original','original');
 INSERT INTO machines(id,name,slug,description,manufacturer,model,"categoryId",status,"updatedAt") VALUES ('machine','Original','original','Original description','Original manufacturer','CAT 320','category','PUBLISHED',NOW());
 INSERT INTO machine_images(id,"machineId",url,alt) VALUES ('image','machine','https://example.test/original.jpg','Original');
 INSERT INTO machine_specifications(id,"machineId",label,value) VALUES ('spec','machine','Power','5 kW');
 INSERT INTO rfqs(id,"rfqNumber","buyerId","machineId",title,description,quantity,unit,"deliveryLocation","deliveryTimeline",status,"updatedAt") VALUES ('rfq','RFQ-1','buyer','machine','Original request','Private',1,'unit','Private','30 days','ACCEPTED',NOW());
 INSERT INTO rfq_recipients(id,"rfqId","recipientId","recipientRole","routingReason","updatedAt") VALUES ('lead','rfq','seller','SUPPLIER','AUTO',NOW());
 INSERT INTO rfq_quotes(id,"rfqId","recipientId","unitPrice",currency,moq,"leadTimeDays","validUntil",notes,status,"updatedAt") VALUES ('quote','rfq','lead',98765.43,'USD',1,7,NOW()+INTERVAL '1 day','Private','ACCEPTED',NOW());
 INSERT INTO sales_opportunities(id,"recipientId",stage,"updatedAt") VALUES ('opportunity','lead','WON',NOW());
 INSERT INTO sale_records(id,"opportunityId","recipientId","acceptedQuoteId","recordedById",status,"completedAt","updatedAt") VALUES ('sale','opportunity','lead','quote','seller','COMPLETED',NOW(),NOW());
 INSERT INTO reviews(id,"saleId","authorId",target,"machineId",rating,body,status,"updatedAt") VALUES ('review','sale','buyer','MACHINERY','machine',5,'Original review','PENDING',NOW());
 INSERT INTO content_translations(id,"cacheKey","machineId",field,"sourceLanguage","targetLanguage","sourceHash","translatedText",status,"updatedAt") VALUES ('translation','MACHINERY:machine:NAME:bn','machine','NAME','en','bn',repeat('a',64),'যন্ত্রপাতি','COMPLETED',NOW());`);
    const mediaKey = `machinery/${randomUUID()}/${randomUUID()}.glb`;
    await client.query(
      `INSERT INTO machine_media(id,"machineId",type,title,"storageKey","fileName","fileType","fileSize",sha256) VALUES ('media','machine','MODEL_3D','Original model',$1,'model.glb','model/gltf-binary',500,repeat('a',64))`,
      [mediaKey],
    );
    for (const name of names.filter((n) => n >= '20261005100000'))
      await client.query(
        await readFile(new URL(`${name}/migration.sql`, root), 'utf8'),
      );
    assert.equal(
      (await client.query('SELECT description FROM machines')).rows[0]
        .description,
      'Original description',
    );
    assert.equal(
      (await client.query('SELECT "unitPrice" FROM rfq_quotes')).rows[0]
        .unitPrice,
      '98765.43',
    );
    assert.equal(
      (await client.query('SELECT body FROM reviews')).rows[0].body,
      'Original review',
    );
    assert.equal(
      (await client.query('SELECT "translatedText" FROM content_translations'))
        .rows[0].translatedText,
      'যন্ত্রপাতি',
    );
    assert.equal(
      (await client.query('SELECT "storageKey" FROM machine_media')).rows[0]
        .storageKey,
      mediaKey,
    );
    await client.query(
      `INSERT INTO service_tickets(id,"customerId","machineId","saleId","customerRequestId",subject,description,"updatedAt") VALUES ('ticket','buyer','machine','sale','request','Issue','Please inspect',NOW())`,
    );
    const fail = async (sql: string, code: string) => {
      await client.query('SAVEPOINT invalid');
      await assert.rejects(
        client.query(sql),
        (e: unknown) =>
          typeof e === 'object' && e !== null && 'code' in e && e.code === code,
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid');
    };
    await fail("UPDATE service_tickets SET status='ASSIGNED'", '23514');
    await fail(
      "UPDATE service_tickets SET status='ASSIGNED',\"assignedToId\"='buyer'",
      '23514',
    );
    await fail(
      "UPDATE service_tickets SET status='RESOLVED',\"assignedToId\"='seller'",
      '23514',
    );
    await fail(
      'UPDATE service_tickets SET "warrantyAssessment"=\'APPROVED\'',
      '23514',
    );
    await fail('UPDATE service_tickets SET "machineId"=\'missing\'', '23503');
    await fail("DELETE FROM sale_records WHERE id='sale'", '23503');
    await fail(
      `INSERT INTO service_tickets(id,"customerId","machineId","saleId","customerRequestId",subject,description,"updatedAt") VALUES ('duplicate','buyer','machine','sale','request','Issue','Please inspect',NOW())`,
      '23505',
    );
    await client.query(
      `UPDATE service_tickets SET status='ASSIGNED',"assignedToId"='seller'; UPDATE service_tickets SET status='IN_PROGRESS'; UPDATE service_tickets SET status='RESOLVED',resolution='Repaired',"resolvedAt"=NOW(); UPDATE service_tickets SET status='CLOSED',"closedAt"=NOW();`,
    );
    assert.equal(
      (await client.query('SELECT status FROM service_tickets')).rows[0].status,
      'CLOSED',
    );
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
