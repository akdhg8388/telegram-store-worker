-- V21. Referral reward policy, off by default; nothing retroactive.
-- 0 max_purchases means lifetime. Integer basis points (500 = 5%).
CREATE TABLE referral_policy(
 id INTEGER PRIMARY KEY CHECK(id=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN(0,1)),
 visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN(0,1)),
 basis_points INTEGER NOT NULL DEFAULT 500 CHECK(basis_points BETWEEN 0 AND 3000),
 max_purchases INTEGER NOT NULL DEFAULT 0 CHECK(max_purchases BETWEEN 0 AND 100000),
 min_purchase_iqd INTEGER NOT NULL DEFAULT 0 CHECK(min_purchase_iqd BETWEEN 0 AND 100000000),
 max_reward_iqd INTEGER NOT NULL DEFAULT 0 CHECK(max_reward_iqd BETWEEN 0 AND 100000000)
);
INSERT INTO referral_policy(id) VALUES(1);
CREATE TABLE referral_rewards(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 purchase_id INTEGER NOT NULL UNIQUE REFERENCES wallet_purchases(id),
 buyer_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
 referrer_tg_id INTEGER NOT NULL REFERENCES users(tg_id),
 purchase_iqd INTEGER NOT NULL CHECK(purchase_iqd>0),
 reward_iqd INTEGER NOT NULL CHECK(reward_iqd>0),
 percent_basis_points INTEGER NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(buyer_tg_id<>referrer_tg_id)
);
CREATE INDEX idx_referral_rewards_referrer ON referral_rewards(referrer_tg_id,id DESC);
CREATE INDEX idx_referral_rewards_buyer ON referral_rewards(buyer_tg_id,id);
-- Same SQLite statement/transaction as checkout. One purchase -> at most one reward.
-- Count earlier rewards for this invitee. No reward until a successful purchase.
CREATE TRIGGER referral_reward_on_purchase AFTER INSERT ON wallet_purchases
BEGIN
 INSERT INTO referral_rewards(purchase_id,buyer_tg_id,referrer_tg_id,purchase_iqd,reward_iqd,percent_basis_points)
 SELECT NEW.id,NEW.user_tg_id,r.referrer_tg_id,NEW.price_iqd,
  CASE WHEN p.max_reward_iqd>0 THEN MIN(p.max_reward_iqd,(NEW.price_iqd*p.basis_points)/10000)
       ELSE (NEW.price_iqd*p.basis_points)/10000 END,
  p.basis_points
 FROM referrals r CROSS JOIN referral_policy p
 WHERE r.user_tg_id=NEW.user_tg_id AND p.id=1 AND p.enabled=1
  AND r.referrer_tg_id<>NEW.user_tg_id
  AND NEW.price_iqd>=p.min_purchase_iqd AND p.basis_points>0
  AND (p.max_purchases=0 OR
       (SELECT COUNT(*) FROM referral_rewards rw WHERE rw.buyer_tg_id=NEW.user_tg_id)<p.max_purchases)
  AND (CASE WHEN p.max_reward_iqd>0 THEN MIN(p.max_reward_iqd,(NEW.price_iqd*p.basis_points)/10000)
      ELSE (NEW.price_iqd*p.basis_points)/10000 END)>0;
END;
CREATE TRIGGER referral_reward_credit AFTER INSERT ON referral_rewards
BEGIN
 INSERT INTO wallet_ledger(user_tg_id,delta_iqd,kind,source_key,note)
 VALUES(NEW.referrer_tg_id,NEW.reward_iqd,'adjustment',
  'referral_reward:'||NEW.purchase_id,'مكافأة إحالة لشراء #'||NEW.purchase_id);
END;
