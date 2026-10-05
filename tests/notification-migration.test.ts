import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { Client } from 'pg';
import { config } from '../src/config/env.js';

test('M11 additive migration preserves M10 history and existing RFQ email intents, with bounded unique service delivery records', async () => {
  const client = new Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  const schema = 'm11_upgrade_' + randomUUID().replaceAll('-', '');
  const root = new URL('../prisma/migrations/', import.meta.url);
  const names = (await readdir(root)).filter((n) => /^\d/.test(n)).sort();
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE SCHEMA "${schema}"; SET LOCAL search_path TO "${schema}"`,
    );
    for (const name of names.filter((n) => n < '20261005120000'))
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
      INSERT INTO service_tickets(id,"customerId","machineId","saleId","customerRequestId",subject,description,"updatedAt") VALUES ('ticket','buyer','machine','sale','request','Original issue','Original service description',NOW());
    `);
    await client.query(`
      INSERT INTO service_ticket_events(id,"ticketId","actorId",type,note) VALUES ('event','ticket','buyer','TICKET_CREATED','Original event');
      INSERT INTO rfq_events(id,"rfqId","eventType",metadata) VALUES ('rfq-event','rfq','SUBMITTED','{}');
      INSERT INTO rfq_email_deliveries(id,"eventId","userId",status,"queuedAt","sentAt","updatedAt") VALUES ('queued','rfq-event','buyer','QUEUED',NOW(),NULL,NOW()),('sent','rfq-event','seller','SENT',NOW(),NOW(),NOW());
    `);
    const before = (await client.query('SELECT * FROM service_tickets')).rows;
    const beforeEvents = (
      await client.query('SELECT * FROM service_ticket_events')
    ).rows;
    await client.query(
      await readFile(
        new URL('20261005120000_notification_delivery/migration.sql', root),
        'utf8',
      ),
    );
    assert.deepEqual(
      (await client.query('SELECT * FROM service_tickets')).rows,
      before,
    );
    assert.deepEqual(
      (await client.query('SELECT * FROM service_ticket_events')).rows,
      beforeEvents,
    );
    assert.equal(
      (
        await client.query(
          'SELECT COUNT(*)::int AS count FROM notification_email_deliveries',
        )
      ).rows[0].count,
      0,
    );
    const deliveries = (
      await client.query(
        'SELECT id,status,"firstAttemptAt","providerMessageId","sendAttempts" FROM rfq_email_deliveries ORDER BY id',
      )
    ).rows;
    assert.equal(deliveries[0].status, 'QUEUED');
    assert.ok(deliveries[0].firstAttemptAt);
    assert.equal(deliveries[1].status, 'SENT');
    assert.equal(deliveries[1].providerMessageId, null);
    assert.equal(deliveries[1].sendAttempts, 0);
    await client.query(
      `INSERT INTO notification_email_deliveries(id,"eventId","userId","updatedAt") VALUES ('notification','event','buyer',NOW())`,
    );
    const invalid = async (sql: string, code: string) => {
      await client.query('SAVEPOINT invalid');
      await assert.rejects(
        client.query(sql),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === code,
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid');
    };
    await invalid(
      `INSERT INTO notification_email_deliveries(id,"eventId","userId","updatedAt") VALUES ('duplicate','event','buyer',NOW())`,
      '23505',
    );
    await invalid(
      `UPDATE notification_email_deliveries SET "sendAttempts"=6`,
      '23514',
    );
    await invalid(
      `UPDATE notification_email_deliveries SET attempts=-1`,
      '23514',
    );
    await invalid(
      `UPDATE notification_email_deliveries SET "eventId"='missing'`,
      '23503',
    );
    assert.equal(
      (await client.query('SELECT "unitPrice" FROM rfq_quotes')).rows[0]
        .unitPrice,
      '98765.43',
    );
    await client.query('DELETE FROM notification_email_deliveries');
    assert.deepEqual(
      (await client.query('SELECT * FROM service_ticket_events')).rows,
      beforeEvents,
    );
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
