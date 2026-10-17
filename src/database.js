export async function ensureUser(db, u) {
  if(!u?.id) return;
  await db.prepare(`INSERT INTO users (tg_id,first_name,username) VALUES (?,?,?)
    ON CONFLICT(tg_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, updated_at=CURRENT_TIMESTAMP`)
    .bind(u.id, String(u.first_name ?? '').slice(0,150), u.username ? String(u.username).slice(0,120) : null).run();
}
export async function getUser(db, userId) { return db.prepare('SELECT * FROM users WHERE tg_id=?').bind(userId).first(); }
export async function setSession(db, uid, action, payload={}) {
  return db.prepare(`INSERT INTO user_sessions(user_tg_id,action,payload) VALUES (?,?,?)
    ON CONFLICT(user_tg_id) DO UPDATE SET action=excluded.action,payload=excluded.payload,updated_at=CURRENT_TIMESTAMP`)
    .bind(uid,action,JSON.stringify(payload)).run();
}
export async function getSession(db, uid) {
  const result = await db.prepare('SELECT action,payload FROM user_sessions WHERE user_tg_id=?').bind(uid).first();
  if(!result) return null;
  try{return {action:result.action, payload:JSON.parse(result.payload)}}catch{return null}
}
export async function clearSession(db, uid) { return db.prepare('DELETE FROM user_sessions WHERE user_tg_id=?').bind(uid).run(); }
export async function listCategories(db) {
  const r=await db.prepare('SELECT * FROM categories WHERE active=1 ORDER BY sort_order,id').all(); return r.results??[];
}
export async function listProducts(db, page=0, categoryId=null, search=null) {
  const limit=10, offset=Math.max(0,page)*limit;
  let sql=`SELECT p.*, c.title AS category_title FROM products p JOIN categories c ON c.id=p.category_id WHERE p.active=1 AND c.active=1`;
  const args=[];
  if(categoryId){sql+=' AND p.category_id=?';args.push(categoryId)}
  if(search){sql+=' AND (p.title LIKE ? OR p.description LIKE ?)';args.push(`%${search}%`,`%${search}%`)}
  sql+=' ORDER BY p.featured DESC,p.id DESC LIMIT ? OFFSET ?';args.push(limit,offset);
  return (await db.prepare(sql).bind(...args).all()).results??[];
}
export async function getProduct(db,id) {return db.prepare('SELECT * FROM products WHERE id=? AND active=1').bind(id).first()}
export async function listOrders(db,uid){return (await db.prepare(`SELECT o.*,p.title FROM orders o JOIN products p ON o.product_id=p.id WHERE o.user_tg_id=? ORDER BY o.id DESC LIMIT 12`).bind(uid).all()).results??[]}
export async function ledger(db,uid){return (await db.prepare('SELECT * FROM wallet_ledger WHERE user_tg_id=? ORDER BY id DESC LIMIT 15').bind(uid).all()).results??[]}
export async function audit(db,admin,action,type,id){await db.prepare('INSERT INTO admin_actions(admin_tg_id,action,target_type,target_id) VALUES (?,?,?,?)').bind(admin,action,type,id).run()}
