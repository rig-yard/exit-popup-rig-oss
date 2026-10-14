-- ADPOP 0004(D1): PC / スマホ別の表示設定・デザイン(データモデル・管理 API。画面も配信も変えない)。
--
-- 🔴 **追加だけ**(既存の表・索引・トリガは1つも変えない。tests/d1-migration-additive.test.ts がスキーマの差分で見る)。
-- 🔴 REPLACE の守り(0001 の末尾と同じ形)を、ここで足す一意なキーにも置く(tests/d1-replace.test.ts が一覧を突き合わせる)。
--
-- 設計: **既存の表(popups / popup_triggers / variants)は「PC の値」とみなし、
--   スマホの分だけ表を3つ足す**。列を増やす・端末の列を持つ行に作り直す、のどちらも既存の表の SQL を
--   変えるため不可。**既存データの移行は INSERT ... SELECT だけ**(既存行の UPDATE は1つも無い)。

-- ══════════════════════════════════════════════════════════════════════
-- 表示設定(きっかけ・頻度)
-- ══════════════════════════════════════════════════════════════════════
-- 🔴 「PC と同じ」の単位は「きっかけ」と「頻度」の2つ。1つのスイッチにしない。
create table popup_mobile_display (
  popup_id   text primary key check (length(popup_id) = 36),
  owner_id   text not null,
  -- 'same_as_pc' の間は、画面はこの行の値ではなく popups / popup_triggers の値を使う
  triggers_mode  text not null default 'same_as_pc' check (triggers_mode in ('same_as_pc', 'custom')),
  frequency_mode text not null default 'same_as_pc' check (frequency_mode in ('same_as_pc', 'custom')),
  -- 列の意味・範囲は popups の同名の列と同じ
  suppress_days             integer not null default 7  check (suppress_days between 0 and 32767),
  session_impressions       integer not null default 1  check (session_impressions between 1 and 32767),
  post_conversion_days      integer not null default 30 check (post_conversion_days between 0 and 32767),
  min_display_delay_seconds integer not null default 3  check (min_display_delay_seconds between 0 and 32767),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  foreign key (popup_id, owner_id) references popups (id, owner_id) on delete cascade
);

-- ポップ1つにつきちょうど6行(popup_triggers と同じ形)
create table popup_mobile_triggers (
  owner_id   text not null,
  popup_id   text not null,
  kind       text not null
               check (kind in ('back', 'scroll', 'idle', 'dwell', 'visibility', 'exit_intent')),
  enabled    integer not null default 0 check (enabled in (0, 1)),
  threshold  integer null check (threshold is null or threshold >= 0),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (popup_id, kind),
  foreign key (popup_id, owner_id) references popups (id, owner_id) on delete cascade
);

-- ══════════════════════════════════════════════════════════════════════
-- デザイン(パターン)
-- ══════════════════════════════════════════════════════════════════════
-- パターン1つにつきちょうど1行。🔴 推奨 = パターンごとにスマホ用の上書きを持つ(対象デバイス案は採らない)
create table variant_mobile_designs (
  variant_id text primary key check (length(variant_id) = 36),
  owner_id   text not null,
  mode       text not null default 'same_as_pc' check (mode in ('same_as_pc', 'custom')),
  -- 'same_as_pc' のときは null。'custom' のときだけ 'text' か 'image'
  kind       text null check (kind is null or kind in ('text', 'image')),
  content    text not null default '{}'
               check (json_valid(content) and json_type(content) = 'object'),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  check (mode = 'same_as_pc' or kind is not null),
  foreign key (variant_id, owner_id) references variants (id, owner_id) on delete cascade
);

-- ══════════════════════════════════════════════════════════════════════
-- 行を揃えるトリガ。🔴 既定値を写しで持たない
-- ══════════════════════════════════════════════════════════════════════

-- ポップを作ったら表示設定の行を1つ。頻度は popups の行の値(= 0001 の列既定値、または渡された値)から写す
create trigger popups_seed_mobile_display after insert on popups
BEGIN
  insert into popup_mobile_display
    (owner_id, popup_id, suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
  values
    (new.owner_id, new.id, new.suppress_days, new.session_impressions, new.post_conversion_days, new.min_display_delay_seconds);
end;

-- 🔴 スマホの6トリガの行は「popup_triggers に行が入ったら、同じ値でスマホにも入れる」形にする
--   (popups 側の複数の AFTER INSERT トリガの発火順には依存しない。既定値は 0001 の popups_seed_triggers の1か所のまま)
create trigger popup_triggers_seed_mobile after insert on popup_triggers
BEGIN
  insert into popup_mobile_triggers (owner_id, popup_id, kind, enabled, threshold)
  values (new.owner_id, new.popup_id, new.kind, new.enabled, new.threshold);
end;

-- パターンを作ったらデザインの行を1つ(same_as_pc・kind は null・content は空)
create trigger variants_seed_mobile_design after insert on variants
BEGIN
  insert into variant_mobile_designs (owner_id, variant_id) values (new.owner_id, new.id);
end;

-- ══════════════════════════════════════════════════════════════════════
-- 変えてはいけない列(0001 と同じ形)
-- ══════════════════════════════════════════════════════════════════════
create trigger popup_mobile_display_immutable before update of popup_id, owner_id on popup_mobile_display
when new.popup_id is not old.popup_id or new.owner_id is not old.owner_id
BEGIN
  select raise(abort, 'adpop:immutable:popup_mobile_display');
end;

create trigger popup_mobile_triggers_immutable before update of owner_id, popup_id, kind on popup_mobile_triggers
when new.owner_id is not old.owner_id or new.popup_id is not old.popup_id or new.kind is not old.kind
BEGIN
  select raise(abort, 'adpop:immutable:popup_mobile_triggers');
end;

create trigger variant_mobile_designs_immutable before update of variant_id, owner_id on variant_mobile_designs
when new.variant_id is not old.variant_id or new.owner_id is not old.owner_id
BEGIN
  select raise(abort, 'adpop:immutable:variant_mobile_designs');
end;

-- ══════════════════════════════════════════════════════════════════════
-- REPLACE を止める(0001 末尾と同じ形・同じ理由)
-- ══════════════════════════════════════════════════════════════════════
create trigger popup_mobile_display_no_replace before insert on popup_mobile_display
when exists (select 1 from popup_mobile_display where popup_id = new.popup_id)
BEGIN
  select raise(abort, 'adpop:conflict:popup_mobile_display');
end;

create trigger popup_mobile_triggers_no_replace before insert on popup_mobile_triggers
when exists (select 1 from popup_mobile_triggers where popup_id = new.popup_id and kind = new.kind)
BEGIN
  select raise(abort, 'adpop:conflict:popup_mobile_triggers');
end;

create trigger variant_mobile_designs_no_replace before insert on variant_mobile_designs
when exists (select 1 from variant_mobile_designs where variant_id = new.variant_id)
BEGIN
  select raise(abort, 'adpop:conflict:variant_mobile_designs');
end;

-- ══════════════════════════════════════════════════════════════════════
-- 既存データの移行。🔴 INSERT ... SELECT だけ(既存行の UPDATE は1つも無い)
-- ══════════════════════════════════════════════════════════════════════
insert into popup_mobile_display
  (owner_id, popup_id, suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
select owner_id, id, suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds from popups;

insert into popup_mobile_triggers (owner_id, popup_id, kind, enabled, threshold)
select owner_id, popup_id, kind, enabled, threshold from popup_triggers;

insert into variant_mobile_designs (owner_id, variant_id)
select owner_id, id from variants;
