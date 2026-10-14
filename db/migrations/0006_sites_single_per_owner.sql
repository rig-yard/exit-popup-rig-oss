-- ADPOP 0006(D1): 1インストール = 1サイト。
--
-- 🔴 **追加だけ**(既存の表・索引・トリガは1つも変えない。tests/d1-migration-additive.test.ts がスキーマの差分で見る)。
--   既存の `sites_limit`(0001・1人20サイトまで)は消さない・弱めない。この新しいトリガは
--   それより**厳しい**規則を足すだけ(「既に1つあれば2つ目は作れない」)。
--
-- v1 は管理者1人なので「インストールに1つ」と「所有者に1つ」が同じ意味になる。
-- 所有者ごとにしたのは、全体で1つにすると `tests/d1-owner-isolation.test.ts` の
-- 「2所有者それぞれ1サイトは作れる」が壊れ、「将来のマルチテナント化のために owner_id を持つ」
-- 前提とも食い違うため。
--
-- 🔴 既存の行は消さない・変えない。本番は1サイトだけ(実測)なので、このマイグレーションを当てても
-- 何も壊れない。⚠ 2サイト以上を既に持つ所有者がいる環境では、**既存のサイトはそのまま残り、
-- その所有者がもう新しいサイトを作れなくなるだけ**(README「D1 に移して弱くなった守り」の下に追記)。
create trigger sites_single before insert on sites
when exists (select 1 from sites where owner_id = new.owner_id)
BEGIN
  select raise(abort, 'adpop:limit:sites');
end;
