-- ADPOP 0007(D1): WORKSPACE 名(Slack と同じ概念。1インストール=1 owner に1つ。サイトとは別のデータ)。
--
-- 🔴 **追加だけ**(既存の表・索引・トリガは1つも変えない。tests/d1-migration-additive.test.ts がスキーマの差分で見る)。
-- `owners` に列を足すと既存の表の SQL が変わってしまう(ALTER TABLE ADD COLUMN も該当)ため、
-- 新しい表で持つ(site_display_settings と同じ考え方)。
--
-- WORKSPACE はサイト(タグを貼る LP のドメインの単位)とは別の概念: 管理画面を使うチーム・組織の単位で、
-- v1 は owner 1人につきちょうど1行。サイトの名前(sites.name)とは独立したデータとして持つ
-- (「サイトはサイトのまま、WORKSPACE は別の単位」という決定による)。

create table workspaces (
  owner_id   text primary key references owners (id) on delete cascade,
  name       text not null check (length(trim(name)) > 0),
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ══════════════════════════════════════════════════════════════════════
-- 新しい owner ができたときの既定値(「Workspace」固定。サイトが無いこともあるため)。
-- 🔴 `ensureOwner`(src/lib/data/admin.ts)は `insert ... on conflict (id) do nothing` なので、
--   既存の owner に対しては発火しない(= 下の backfill が既存分を埋める)。
-- ══════════════════════════════════════════════════════════════════════
create trigger owners_seed_workspace after insert on owners
BEGIN
  insert into workspaces (owner_id, name) values (new.id, 'Workspace');
end;

-- ══════════════════════════════════════════════════════════════════════
-- 変えてはいけない列(0001・0004・0005・0006 と同じ形)
-- ══════════════════════════════════════════════════════════════════════
create trigger workspaces_immutable before update of owner_id on workspaces
when new.owner_id is not old.owner_id
BEGIN
  select raise(abort, 'adpop:immutable:workspaces');
end;

-- ══════════════════════════════════════════════════════════════════════
-- REPLACE を止める(0001・0004・0005・0006 と同じ形)
-- ══════════════════════════════════════════════════════════════════════
create trigger workspaces_no_replace before insert on workspaces
when exists (select 1 from workspaces where owner_id = new.owner_id)
BEGIN
  select raise(abort, 'adpop:conflict:workspaces');
end;

-- ══════════════════════════════════════════════════════════════════════
-- 既存の owner の backfill(この表は今日できたばかりなので、既存の owner には
-- `owners_seed_workspace` が発火していない。既存行の UPDATE は使えないので、
-- 入れる時点で正しい値にする)。
-- 名前の出どころ: その owner が持つ最初のサイトの名前。
-- サイトが1つも無ければ既定値「Workspace」。
-- ══════════════════════════════════════════════════════════════════════
insert into workspaces (owner_id, name)
select o.id,
  coalesce(
    (select s.name from sites s where s.owner_id = o.id order by s.created_at asc, s.id asc limit 1),
    'Workspace'
  )
from owners o
where not exists (select 1 from workspaces w where w.owner_id = o.id);
