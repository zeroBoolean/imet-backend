import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { config } from '../src/config/env.js';

// A rolled-back private schema verifies the complete upgrade without resetting any data.
test('M7 review migration preserves sales and enforces target, rating and duplicate guards', async () => {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  const schema = `m6_upgrade_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    const root = new URL('../prisma/migrations/', import.meta.url);
    const migrations = (await readdir(root, { withFileTypes: true }))
      .filter((f) => f.isDirectory())
      .map((f) => f.name)
      .sort();
    const m6 = '20261004120000_sales_management';
    for (const migration of migrations.filter((m) => m < m6))
      await client.query(
        await readFile(new URL(`${migration}/migration.sql`, root), 'utf8'),
      );
    await client.query(`INSERT INTO users (id,email,"displayName",password,"updatedAt")
      VALUES ('buyer','upgrade-buyer@example.test','Buyer','fixture',NOW()),
      ('seller','upgrade-seller@example.test','Seller','fixture',NOW()),
      ('other','upgrade-other@example.test','Other','fixture',NOW())`);
    const cases = [
      { id: 'new', rfq: 'ROUTED', lead: 'NEW', quote: null, expected: 'NEW' },
      {
        id: 'quoted',
        rfq: 'QUOTED',
        lead: 'QUOTED',
        quote: 'PENDING',
        expected: 'QUOTED',
      },
      {
        id: 'won',
        rfq: 'CLOSED',
        lead: 'CLOSED',
        quote: 'ACCEPTED',
        expected: 'WON',
      },
      {
        id: 'expired',
        rfq: 'EXPIRED',
        lead: 'CLOSED',
        quote: 'WITHDRAWN',
        expected: 'LOST',
      },
      {
        id: 'declined',
        rfq: 'ROUTED',
        lead: 'DECLINED',
        quote: null,
        expected: 'LOST',
      },
    ];
    for (const c of cases) {
      await client.query(
        `INSERT INTO rfqs (id,"rfqNumber","buyerId",title,description,quantity,unit,"deliveryLocation","deliveryTimeline",status,"updatedAt")
        VALUES ($1::text,$1::text,'buyer','Original requirement','Original description',2,'units','Dhaka','30 days',$2,NOW())`,
        [c.id, c.rfq],
      );
      await client.query(
        `INSERT INTO rfq_recipients (id,"rfqId","recipientId","recipientRole","leadStatus","routingReason","updatedAt")
        VALUES ($1,$1,'seller','SUPPLIER',$2,'AUTO',NOW())`,
        [c.id, c.lead],
      );
      if (c.quote)
        await client.query(
          `INSERT INTO rfq_quotes (id,"rfqId","recipientId","unitPrice",currency,moq,"leadTimeDays","validUntil",notes,status,"updatedAt")
        VALUES ($1,$1,$1,123.45,'USD',1,7,NOW() + interval '1 day','Original quote',$2,NOW())`,
          [c.id, c.quote],
        );
    }
    // A removed competitor of the accepted winner must not inherit WON or access its quote.
    await client.query(`INSERT INTO rfq_recipients (id,"rfqId","recipientId","recipientRole","leadStatus","routingReason","removedAt","updatedAt")
      VALUES ('loser','won','other','SUPPLIER','CLOSED','AUTO',NOW(),NOW())`);
    const before = await client.query('SELECT * FROM rfqs ORDER BY id');
    await client.query(
      await readFile(new URL(`${m6}/migration.sql`, root), 'utf8'),
    );
    const after = await client.query('SELECT * FROM rfqs ORDER BY id');
    assert.deepEqual(after.rows, before.rows);
    const opportunities = await client.query(
      'SELECT id,"recipientId",stage FROM sales_opportunities',
    );
    assert.equal(opportunities.rows.length, 6);
    for (const c of cases)
      assert.equal(
        opportunities.rows.find((o) => o.recipientId === c.id)?.stage,
        c.expected,
      );
    assert.equal(
      opportunities.rows.find((o) => o.recipientId === 'loser')?.stage,
      'LOST',
    );
    assert.equal(
      (await client.query('SELECT * FROM sales_events')).rows.length,
      6,
    );
    assert.equal(
      (await client.query('SELECT * FROM sale_records')).rows.length,
      0,
    );
    const won = opportunities.rows.find((o) => o.recipientId === 'won').id;
    const loser = opportunities.rows.find((o) => o.recipientId === 'loser').id;
    await client.query(
      `INSERT INTO sale_records (id,"opportunityId","recipientId","acceptedQuoteId","recordedById","updatedAt")
      VALUES ('sale',$1,'won','won','seller',NOW())`,
      [won],
    );
    const rejected = async (sql: string, values: string[], code: string) => {
      await client.query('SAVEPOINT invalid_case');
      await assert.rejects(
        client.query(sql, values),
        (error: unknown) =>
          error instanceof Error && 'code' in error && error.code === code,
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid_case');
    };
    await rejected(
      `INSERT INTO sale_records (id,"opportunityId","recipientId","acceptedQuoteId","recordedById","updatedAt")
      VALUES ('bad',$1,'loser','quoted','other',NOW())`,
      [loser],
      '23503',
    );
    await rejected(
      `UPDATE sale_records SET status='CANCELLED' WHERE id='sale'`,
      [],
      '23514',
    );
    await rejected(
      `INSERT INTO sale_records (id,"opportunityId","recipientId","acceptedQuoteId","recordedById","updatedAt")
      VALUES ('duplicate',$1,'won','won','seller',NOW())`,
      [won],
      '23505',
    );
    await rejected(`DELETE FROM rfq_quotes WHERE id='won'`, [], '23503');
    await client.query(
      `UPDATE sale_records SET status='COMPLETED', "completedAt"=NOW() WHERE id='sale'`,
    );
    const salesBefore = await client.query('SELECT * FROM sale_records');
    await client.query(
      await readFile(
        new URL('20261004133000_reviews/migration.sql', root),
        'utf8',
      ),
    );
    assert.deepEqual(
      (await client.query('SELECT * FROM sale_records')).rows,
      salesBefore.rows,
    );
    await client.query(
      `INSERT INTO machine_categories (id,name,slug) VALUES ('category','Category','category')`,
    );
    await client.query(
      `INSERT INTO machines (id,name,slug,description,manufacturer,model,"categoryId","updatedAt") VALUES ('machine','Machine','machine','Technical machinery','Maker','Model','category',NOW())`,
    );
    await client.query(
      `INSERT INTO reviews (id,"saleId","authorId",target,"machineId",rating,body,"updatedAt") VALUES ('review','sale','buyer','MACHINERY','machine',5,'Buyer experience',NOW())`,
    );
    await rejected(
      `UPDATE reviews SET rating=6 WHERE id='review'`,
      [],
      '23514',
    );
    await rejected(
      `UPDATE reviews SET "machineId"=NULL WHERE id='review'`,
      [],
      '23514',
    );
    await rejected(
      `UPDATE reviews SET body='   ' WHERE id='review'`,
      [],
      '23514',
    );
    await rejected(
      `INSERT INTO reviews (id,"saleId","authorId",target,"machineId",rating,body,"updatedAt") VALUES ('duplicate','sale','buyer','MACHINERY','machine',5,'Buyer experience',NOW())`,
      [],
      '23505',
    );
    await rejected(`DELETE FROM sale_records WHERE id='sale'`, [], '23503');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
