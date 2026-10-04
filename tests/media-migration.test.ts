import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import pg from 'pg';
import { config } from '../src/config/env.js';
test('M9 additive migrations preserve existing catalogue and enforce media integrity and storage cleanup relationships', async () => {
  const c = new pg.Client({ connectionString: config.DATABASE_URL }),
    schema = `m9_upgrade_${randomUUID().replaceAll('-', '')}`;
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`CREATE SCHEMA "${schema}"`);
    await c.query(`SET LOCAL search_path TO "${schema}", public`);
    const root = new URL('../prisma/migrations/', import.meta.url),
      names = (await readdir(root, { withFileTypes: true }))
        .filter((x) => x.isDirectory())
        .map((x) => x.name)
        .sort();
    for (const name of names.filter((n) => n < '20261004170000'))
      await c.query(
        await readFile(new URL(`${name}/migration.sql`, root), 'utf8'),
      );
    await c.query(
      `INSERT INTO machine_categories(id,name,slug) VALUES ('category','Existing','existing'); INSERT INTO machines(id,name,slug,description,manufacturer,model,"categoryId",status,"updatedAt") VALUES ('machine','Existing machine','existing-machine','Original content','Original brand','M1','category','PUBLISHED',NOW()); INSERT INTO machine_images(id,"machineId",url,alt) VALUES ('image','machine','https://example.test/existing.jpg','Existing image'); INSERT INTO machine_specifications(id,"machineId",label,value) VALUES ('spec','machine','Power','5 kW')`,
    );
    for (const name of names.filter((n) => n >= '20261004170000'))
      await c.query(
        await readFile(new URL(`${name}/migration.sql`, root), 'utf8'),
      );
    assert.equal(
      (await c.query('SELECT description FROM machines')).rows[0].description,
      'Original content',
    );
    assert.equal(
      (await c.query('SELECT url FROM machine_images')).rows[0].url,
      'https://example.test/existing.jpg',
    );
    assert.equal(
      (await c.query('SELECT value FROM machine_specifications')).rows[0].value,
      '5 kW',
    );
    const key = `machinery/${randomUUID()}/${randomUUID()}.glb`;
    const insert = `INSERT INTO machine_media(id,"machineId",type,title,"storageKey","fileName","fileType","fileSize",sha256) VALUES ('media','machine','MODEL_3D','Inspection',$1,'model.glb','model/gltf-binary',500,$2)`;
    await c.query(insert, [key, 'a'.repeat(64)]);
    const fails = async (sql: string, params: unknown[], code: string) => {
      await c.query('SAVEPOINT guard');
      await assert.rejects(
        c.query(sql, params),
        (e: unknown) =>
          typeof e === 'object' && e !== null && 'code' in e && e.code === code,
      );
      await c.query('ROLLBACK TO SAVEPOINT guard');
    };
    await fails('UPDATE machine_media SET "fileSize"=0', [], '23514');
    await fails(
      'UPDATE machine_media SET "storageKey"=$1',
      ['rfq/private'],
      '23514',
    );
    await fails("UPDATE machine_media SET type='VIDEO'", [], '23514');
    await fails("UPDATE machine_media SET sha256='invalid'", [], '23514');
    await fails("DELETE FROM machines WHERE id='machine'", [], '23503');
    await c.query('DELETE FROM machine_media');
    await c.query("DELETE FROM machines WHERE id='machine'");
    assert.equal(
      (await c.query('SELECT count(*) FROM machine_images')).rows[0].count,
      '0',
    );
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
});
