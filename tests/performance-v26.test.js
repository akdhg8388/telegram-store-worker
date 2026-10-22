import test from 'node:test';
import assert from 'node:assert/strict';
import {userProfileChanged} from '../src/database.js';
import {guardUser} from '../src/moderation.js';
test('V26 unchanged user skips profile write; changed data is synced',()=>{
 const user={tg_id:101,first_name:'Ali',username:'ali',language:'en',wallet_balance_iqd:3500};
 assert.equal(userProfileChanged(user,{id:101,first_name:'Ali',username:'ali'}),false);
 assert.equal(userProfileChanged(user,{id:101,first_name:'Ali',username:'new'}),true);
 assert.equal(userProfileChanged(user,{id:101,first_name:'Ali'}),true);
 assert.equal(userProfileChanged(null,{id:102,first_name:'New'}),true);
});
test('V26 guard uses known user without extra database call',async()=>{
 const db={prepare(){throw Error('unexpected D1 query')}};
 const env={ADMIN_ID:'991'};
 assert.equal(await guardUser(db,env,101,{is_blocked:0,suspended_until:null}),null);
 assert.match(await guardUser(db,env,101,{is_blocked:1,restriction_reason:''}),/تم إيقاف وصولك/);
 assert.equal(await guardUser(db,env,991,null),null);
});
