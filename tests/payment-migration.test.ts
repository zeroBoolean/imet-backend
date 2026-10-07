import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { config } from '../src/config/env.js';
test('payment migrations preserve existing accounts and terms, with unique identities and financial guards', async () => {
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  const schema = `payment_upgrade_${randomUUID().replaceAll('-', '')}`;
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
    const payment = '20261007120000_m4_subscription_payments';
    for (const m of migrations.filter((m) => m < payment))
      await client.query(
        await readFile(new URL(`${m}/migration.sql`, root), 'utf8'),
      );
    await client.query(
      `INSERT INTO users (id,email,"displayName",password,status,"isEmailVerified","updatedAt") VALUES ('owner','owner@example.test','Existing supplier','fixture','ACTIVE',true,NOW())`,
    );
    await client.query(
      `INSERT INTO suppliers (id,"userId","companyName",type,description,"contactName","businessEmail","businessPhone",address,city,country,documents,status,"updatedAt") VALUES ('supplier','owner','Existing company','LOCAL','Existing description','Owner','business@example.test','123456789','Factory Rd','Dhaka','Bangladesh','[]','APPROVED',NOW())`,
    );
    await client.query(
      `INSERT INTO subscription_plans (id,name,"eligibleTypes","durationDays",price,currency,"listingLimit","imageLimit","specificationLimit","canPublishMachinery",visibility,"updatedAt") VALUES ('plan','Existing plan',ARRAY['LOCAL']::"SupplierType"[],30,1500,'BDT',10,5,20,true,'STANDARD',NOW())`,
    );
    await client.query(
      `INSERT INTO supplier_subscriptions (id,"supplierId","planId",state,"startsAt","endsAt","planName","supplierType","durationDays",price,currency,"listingLimit","imageLimit","specificationLimit","canPublishMachinery",visibility,"updatedAt") VALUES ('term','supplier','plan','ACTIVE',NOW(),NOW()+interval '30 days','Existing plan','LOCAL',30,1500,'BDT',10,5,20,true,'STANDARD',NOW())`,
    );
    const before = await client.query('SELECT * FROM supplier_subscriptions');
    for (const m of migrations.filter((m) => m >= payment))
      await client.query(
        await readFile(new URL(`${m}/migration.sql`, root), 'utf8'),
      );
    const after = await client.query('SELECT * FROM supplier_subscriptions');
    for (const [key, value] of Object.entries(before.rows[0]))
      assert.deepEqual(after.rows[0][key], value);
    assert.equal(after.rows[0].activationMethod, null);
    assert.equal(
      (await client.query(`SELECT status FROM users WHERE id='owner'`)).rows[0]
        .status,
      'ACTIVE',
    );
    await client.query(
      `INSERT INTO payment_transactions (id,"userId","subscriptionId","transactionId","idempotencyKey",amount,currency,"expiresAt","updatedAt") VALUES ('payment','owner','term','transaction','idempotency',1500,'BDT',NOW()+interval '30 minutes',NOW())`,
    );
    const reject = async (sql: string, code: string) => {
      await client.query('SAVEPOINT invalid');
      await assert.rejects(
        client.query(sql),
        (e: unknown) => e instanceof Error && 'code' in e && e.code === code,
      );
      await client.query('ROLLBACK TO SAVEPOINT invalid');
    };
    await reject(
      `INSERT INTO payment_transactions (id,"userId","subscriptionId","transactionId","idempotencyKey",amount,currency,"expiresAt","updatedAt") VALUES ('other','owner','term','transaction','other',1500,'BDT',NOW()+interval '30 minutes',NOW())`,
      '23505',
    );
    await reject(
      `UPDATE payment_transactions SET amount=0 WHERE id='payment'`,
      '23514',
    );
    await reject(
      `UPDATE payment_transactions SET currency='bDt' WHERE id='payment'`,
      '23514',
    );
    await reject(
      `UPDATE payment_transactions SET status='PAID' WHERE id='payment'`,
      '23514',
    );
    await reject(
      `UPDATE supplier_subscriptions SET "activationMethod"='ADMIN_MANUAL',"activatedAt"=NOW(),"activationReason"='' WHERE id='term'`,
      '23514',
    );
    await reject(`DELETE FROM users WHERE id='owner'`, '23503');
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
