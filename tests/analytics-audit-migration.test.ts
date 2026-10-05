import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Client } from 'pg';
import { config } from '../src/config/env.js';
test('M12 additive migration preserves M11 domain history and intents, with indexed governance history and protected actor references', async () => {
  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const schema = 'm12_upgrade_' + randomUUID().replaceAll('-', '');
  const root = new URL('../prisma/migrations/', import.meta.url);
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}"`,
    );
    for (const name of (await readdir(root))
      .filter((n) => /^\d/.test(n) && n < '20261005140000')
      .sort())
      await client.query(
        await readFile(new URL(`${name}/migration.sql`, root), 'utf8'),
      );
    await client.query(`
    INSERT INTO users(id,email,"displayName",password,status,"isEmailVerified","updatedAt") VALUES ('buyer','buyer@example.test','Buyer','fixture','ACTIVE',true,NOW()),('seller','seller@example.test','Seller','fixture','ACTIVE',true,NOW());
    INSERT INTO machine_categories(id,name,slug) VALUES ('category','Original category','original');
    INSERT INTO machines(id,name,slug,description,manufacturer,model,"categoryId",status,"updatedAt") VALUES ('machine','Original machine','original','Original description','Original manufacturer','5 kW','category','PUBLISHED',NOW());
    INSERT INTO rfqs(id,"rfqNumber","buyerId","machineId",title,description,quantity,unit,"deliveryLocation","deliveryTimeline",status,"updatedAt") VALUES ('rfq','RFQ-1','buyer','machine','Original request','Private RFQ',1,'unit','Private','30 days','ACCEPTED',NOW());
    INSERT INTO rfq_recipients(id,"rfqId","recipientId","recipientRole","routingReason","updatedAt") VALUES ('lead','rfq','seller','SUPPLIER','AUTO',NOW());
    INSERT INTO rfq_quotes(id,"rfqId","recipientId","unitPrice",currency,moq,"leadTimeDays","validUntil",notes,status,"updatedAt") VALUES ('quote','rfq','lead',98765.43,'USD',1,7,NOW()+INTERVAL '1 day','Private quote','ACCEPTED',NOW());
    INSERT INTO sales_opportunities(id,"recipientId",stage,"updatedAt") VALUES ('opportunity','lead','WON',NOW());
    INSERT INTO sale_records(id,"opportunityId","recipientId","acceptedQuoteId","recordedById",status,"completedAt","updatedAt") VALUES ('sale','opportunity','lead','quote','seller','COMPLETED',NOW(),NOW());
    INSERT INTO service_tickets(id,"customerId","machineId","saleId","customerRequestId",subject,description,"updatedAt") VALUES ('ticket','buyer','machine','sale','request','Original issue','Original description',NOW());
    INSERT INTO service_ticket_events(id,"ticketId","actorId",type,note) VALUES ('event','ticket','buyer','TICKET_CREATED','Private note');
    INSERT INTO rfq_events(id,"rfqId","eventType",metadata) VALUES ('rfq-event','rfq','SUBMITTED','{"private":"original"}');
    INSERT INTO sales_events(id,"opportunityId","eventType",metadata) VALUES ('sales-event','opportunity','SALE_COMPLETED','{"private":"original"}');
    INSERT INTO notification_email_deliveries(id,"eventId","userId",status,"updatedAt") VALUES ('notification','event','buyer','QUEUED',NOW());
    INSERT INTO rfq_email_deliveries(id,"eventId","userId",status,"updatedAt") VALUES ('rfq-notification','rfq-event','seller','SENT',NOW());
  `);
    const tables = [
      'users',
      'machines',
      'rfqs',
      'rfq_quotes',
      'sale_records',
      'service_tickets',
      'rfq_events',
      'sales_events',
      'service_ticket_events',
      'notification_email_deliveries',
      'rfq_email_deliveries',
    ];
    const before = await Promise.all(
      tables.map((table) => client.query(`SELECT * FROM ${table} ORDER BY id`)),
    );
    await client.query(
      await readFile(
        new URL('20261005140000_analytics_audit/migration.sql', root),
        'utf8',
      ),
    );
    for (let i = 0; i < tables.length; i++)
      assert.deepEqual(
        (await client.query(`SELECT * FROM ${tables[i]} ORDER BY id`)).rows,
        before[i].rows,
        tables[i],
      );
    assert.equal(
      (await client.query('SELECT count(*)::int AS count FROM audit_logs'))
        .rows[0].count,
      0,
      'no invented historic governance events',
    );
    await client.query(
      `INSERT INTO audit_logs(id,"actorId",action,"resourceType","resourceId",context) VALUES ('audit','seller','CATEGORY_DELETED','CATEGORY','deleted-category','{}')`,
    );
    await client.query('SAVEPOINT protected_actor');
    await assert.rejects(
      client.query(`DELETE FROM users WHERE id='seller'`),
      (e: unknown) =>
        typeof e === 'object' &&
        e !== null &&
        'code' in e &&
        e.code === '23503',
    );
    await client.query('ROLLBACK TO SAVEPOINT protected_actor');
    const indexes = (
      await client.query(
        'SELECT indexname FROM pg_indexes WHERE schemaname=$1',
        [schema],
      )
    ).rows.map((r: { indexname: string }) => r.indexname);
    for (const name of [
      'audit_logs_createdAt_id_idx',
      'audit_logs_actorId_createdAt_id_idx',
      'audit_logs_resourceType_resourceId_createdAt_id_idx',
      'audit_logs_action_createdAt_id_idx',
      'rfq_events_createdAt_id_idx',
      'sales_events_createdAt_id_idx',
      'service_ticket_events_createdAt_id_idx',
    ])
      assert.ok(indexes.includes(name), name);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
