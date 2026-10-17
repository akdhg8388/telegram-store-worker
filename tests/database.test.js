import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { formatIQD,formatStars,positiveInt,isAdmin,button } from '../src/common.js';

function freshDb(){
  const db=new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
  db.prepare('INSERT INTO users(tg_id,first_name) VALUES (?,?)').run(101,'Ali');
  db.prepare("INSERT INTO products(category_id,title,price_stars,stock) VALUES (1,'Premium',20,2)").run();
  return db;
}

test('database initializes with categories, no fabricated products',()=>{
  const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
  assert.equal(db.prepare('SELECT count(*) n FROM products').get().n,0);
  assert.ok(db.prepare('SELECT count(*) n FROM categories').get().n>=8);
  db.close();
});
test('wallet credit uses unique ledger events and rejects overdraft',()=>{
  const db=freshDb();
  db.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES (101,25000,'topup','topup:1')").run();
  db.prepare("INSERT OR IGNORE INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES (101,25000,'topup','topup:1')").run();
  assert.equal(db.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,25000);
  assert.throws(()=>db.prepare("INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key) VALUES (101,-30000,'permitted_purchase','sale:1')").run(),/insufficient_wallet_funds/);
  assert.equal(db.prepare('SELECT wallet_balance_iqd FROM users WHERE tg_id=101').get().wallet_balance_iqd,25000);
  db.close();
});
test('order stock reserved on admin approval and released on rejection',()=>{
  const db=freshDb();
  const make=()=>db.prepare('INSERT INTO orders(user_tg_id,product_id,unit_price_stars,total_stars) VALUES (101,1,20,20)').run().lastInsertRowid;
  const a=make(),b=make(),c=make();
  db.prepare("UPDATE orders SET status='awaiting_payment' WHERE id=?").run(a);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,1);
  db.prepare("UPDATE orders SET status='awaiting_payment' WHERE id=?").run(b);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,0);
  assert.throws(()=>db.prepare("UPDATE orders SET status='awaiting_payment' WHERE id=?").run(c),/insufficient_stock/);
  db.prepare("UPDATE orders SET status='rejected' WHERE id=?").run(a);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,1);
  db.prepare("UPDATE orders SET status='awaiting_payment' WHERE id=?").run(c);
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,0);
  db.close();
});
test('refunded paid order releases stock, delivered order does not',()=>{
  const db=freshDb();
  db.prepare('INSERT INTO orders(user_tg_id,product_id,unit_price_stars,total_stars) VALUES (101,1,20,20)').run();
  db.prepare("UPDATE orders SET status='awaiting_payment' WHERE id=1").run();
  db.prepare("UPDATE orders SET status='paid_pending_delivery' WHERE id=1").run();
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,1);
  db.prepare("UPDATE orders SET status='refunded' WHERE id=1").run();
  assert.equal(db.prepare('SELECT stock FROM products WHERE id=1').get().stock,2);
  db.close();
});
test('proof reference prevents reusing same payment reference for the method',()=>{
  const db=freshDb();
  const stmt=db.prepare("INSERT INTO topup_requests(user_tg_id,method,amount_iqd,transfer_reference) VALUES (101,'zaincash',25000,'abc123')");
  stmt.run();
  assert.throws(()=>stmt.run(),/UNIQUE/);
  db.close();
});
test('utilities validate admin privileges and input',()=>{
  assert.equal(isAdmin({ADMIN_IDS:'101, 103'},101),true);
  assert.equal(isAdmin({ADMIN_IDS:'101, 103'},104),false);
  assert.equal(positiveInt('0042'),42);
  assert.equal(positiveInt('-1'),null);
  assert.ok(formatIQD(25000).includes('25,000'));
  assert.equal(formatStars(5),'5 ⭐');
  assert.deepEqual(button('Approve','a:1','success'),{text:'Approve',callback_data:'a:1',style:'success'});
});
test('repeated purchase callback creates a single order',()=>{
  const db=freshDb();
  const q=db.prepare('INSERT OR IGNORE INTO orders(user_tg_id,product_id,unit_price_stars,total_stars,source_callback_id) VALUES (101,1,20,20,?)');
  q.run('callbackABC');q.run('callbackABC');
  assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,1);
  db.close();
});
