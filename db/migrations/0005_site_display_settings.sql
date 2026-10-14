-- ADPOP 0005(D1): サイト単位の表示設定(きっかけ・頻度)。
--
-- 表示設定(きっかけ・頻度)はポップごとではなく**サイトごとに1枚**になった。
-- 🔴 **追加だけ**(既存の表・索引・トリガは1つも変えない。tests/d1-migration-additive.test.ts がスキーマの差分で見る)。
-- 🔴 推奨 = **新しい表を2つ足し、端末を「行」で持つ**。既存の `popups` の頻度の列・`popup_triggers`・
--   0004 の `popup_mobile_display` / `popup_mobile_triggers` は**消さずに凍結**(データ層から読みも書きもしない。
--   `tests/frozen-tables.test.ts` が見る)。
-- 🔴 REPLACE の守り(0001・0004 と同じ形)を、ここで足す一意なキーにも置く(tests/d1-replace.test.ts が一覧を突き合わせる)。

-- ══════════════════════════════════════════════════════════════════════
-- サイト単位の表示設定(きっかけ・頻度)
-- ══════════════════════════════════════════════════════════════════════
-- サイト1つにつき desktop・mobile の**ちょうど2行**。
-- 🔴 `triggers_mode` / `frequency_mode` は **mobile の行だけ**持つ(desktop は null。CHECK で強制)。
-- ⚠ SQLite の CHECK は式の結果が NULL なら満たしたことになる(断るのは false のときだけ)。
--   `mode is not null` を明示しないと、device='mobile' かつ mode が NULL のとき
--   `(true and NULL) or false` = NULL になり、CHECK を素通りしてしまう。
create table site_display_settings (
  site_id    text not null check (length(site_id) = 36),
  owner_id   text not null,
  device     text not null check (device in ('desktop', 'mobile')),
  triggers_mode  text check (
    (device = 'mobile' and triggers_mode is not null and triggers_mode in ('same_as_pc', 'custom'))
    or (device = 'desktop' and triggers_mode is null)
  ),
  frequency_mode text check (
    (device = 'mobile' and frequency_mode is not null and frequency_mode in ('same_as_pc', 'custom'))
    or (device = 'desktop' and frequency_mode is null)
  ),
  -- 列の意味・範囲は popups の同名の列と同じ
  suppress_days             integer not null default 7  check (suppress_days between 0 and 32767),
  session_impressions       integer not null default 1  check (session_impressions between 1 and 32767),
  post_conversion_days      integer not null default 30 check (post_conversion_days between 0 and 32767),
  min_display_delay_seconds integer not null default 3  check (min_display_delay_seconds between 0 and 32767),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (site_id, device),
  foreign key (site_id, owner_id) references sites (id, owner_id) on delete cascade
);

-- サイト1つにつき desktop・mobile それぞれ6行(端末2 × 6種)
create table site_display_triggers (
  site_id    text not null check (length(site_id) = 36),
  owner_id   text not null,
  device     text not null check (device in ('desktop', 'mobile')),
  kind       text not null
               check (kind in ('back', 'scroll', 'idle', 'dwell', 'visibility', 'exit_intent')),
  enabled    integer not null default 0 check (enabled in (0, 1)),
  threshold  integer null check (threshold is null or threshold >= 0),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  primary key (site_id, device, kind),
  foreign key (site_id, owner_id) references sites (id, owner_id) on delete cascade
);

-- ══════════════════════════════════════════════════════════════════════
-- サイトを作ったときの既定値。
-- 🔴 既定値を持つのはこのトリガの desktop の行・トリガだけ。mobile は**その行から写す**
--   (0001 の popups_seed_triggers・0004 の仕組みと同じ考え方。既定値を2か所に複製しない)。
-- ══════════════════════════════════════════════════════════════════════
create trigger sites_seed_display_settings after insert on sites
BEGIN
  insert into site_display_settings
    (owner_id, site_id, device, suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
  values
    (new.owner_id, new.id, 'desktop', 7, 1, 30, 3);

  -- 既定値。0001 の popups_seed_triggers と同じ値
  insert into site_display_triggers (owner_id, site_id, device, kind, enabled, threshold) values
    (new.owner_id, new.id, 'desktop', 'back',        1, null),
    (new.owner_id, new.id, 'desktop', 'scroll',      0, 50),
    (new.owner_id, new.id, 'desktop', 'idle',        0, 30),
    (new.owner_id, new.id, 'desktop', 'dwell',       0, 45),
    (new.owner_id, new.id, 'desktop', 'visibility',  0, null),
    (new.owner_id, new.id, 'desktop', 'exit_intent', 1, null);

  -- mobile は desktop の行から写す(モードは same_as_pc)
  insert into site_display_settings
    (owner_id, site_id, device, triggers_mode, frequency_mode,
     suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
  select owner_id, site_id, 'mobile', 'same_as_pc', 'same_as_pc',
         suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds
  from site_display_settings where site_id = new.id and device = 'desktop';

  insert into site_display_triggers (owner_id, site_id, device, kind, enabled, threshold)
  select owner_id, site_id, 'mobile', kind, enabled, threshold
  from site_display_triggers where site_id = new.id and device = 'desktop';
end;

-- ══════════════════════════════════════════════════════════════════════
-- 変えてはいけない列(0001・0004 と同じ形)
-- ══════════════════════════════════════════════════════════════════════
create trigger site_display_settings_immutable before update of site_id, owner_id, device on site_display_settings
when new.site_id is not old.site_id or new.owner_id is not old.owner_id or new.device is not old.device
BEGIN
  select raise(abort, 'adpop:immutable:site_display_settings');
end;

create trigger site_display_triggers_immutable before update of site_id, owner_id, device, kind on site_display_triggers
when new.site_id is not old.site_id or new.owner_id is not old.owner_id
  or new.device is not old.device or new.kind is not old.kind
BEGIN
  select raise(abort, 'adpop:immutable:site_display_triggers');
end;

-- ══════════════════════════════════════════════════════════════════════
-- REPLACE を止める(0001 末尾・0004 と同じ形)
-- ══════════════════════════════════════════════════════════════════════
create trigger site_display_settings_no_replace before insert on site_display_settings
when exists (select 1 from site_display_settings where site_id = new.site_id and device = new.device)
BEGIN
  select raise(abort, 'adpop:conflict:site_display_settings');
end;

create trigger site_display_triggers_no_replace before insert on site_display_triggers
when exists (select 1 from site_display_triggers where site_id = new.site_id and device = new.device and kind = new.kind)
BEGIN
  select raise(abort, 'adpop:conflict:site_display_triggers');
end;

-- ══════════════════════════════════════════════════════════════════════
-- 既存データの引き継ぎ。
-- 🔴 この表は今日できたばかりなので、`sites_seed_display_settings` は既存のサイトには発火していない
--   (既存行の UPDATE は使えないので、INSERT ... SELECT で**入れる時点で正しい値**にする)。
--
-- 出どころ(サイトごとに1つだけ選ぶ・優先順):
--   ① 稼働中(active)のポップ
--   ② (①が無ければ)アーカイブしていないポップのうち updated_at が最も新しいもの(同時刻なら id の小さい方)
--   ③ (①②とも無ければ)既定値
-- ══════════════════════════════════════════════════════════════════════

-- desktop の頻度(①②のポップの popups の値、③は既定値)
with site_source_popup as (
  select s.id as site_id,
    coalesce(
      (select p.id from popups p where p.site_id = s.id and p.status = 'active'),
      (select p.id from popups p where p.site_id = s.id and p.archived_at is null order by p.updated_at desc, p.id asc limit 1)
    ) as popup_id
  from sites s
)
insert into site_display_settings
  (owner_id, site_id, device, suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
select s.owner_id, s.id, 'desktop',
  coalesce(p.suppress_days, 7),
  coalesce(p.session_impressions, 1),
  coalesce(p.post_conversion_days, 30),
  coalesce(p.min_display_delay_seconds, 3)
from sites s
left join site_source_popup ssp on ssp.site_id = s.id
left join popups p on p.id = ssp.popup_id;

-- desktop のトリガ6行(①②のポップの popup_triggers の値、③は既定値)
-- 🔴 既定値を1つの表に起こす(`kinds`)。**UNION ALL の連なりは使わない** ——
--   ローカル D1(workerd の SQLite)は実測で「compound SELECT の項が6つ」を `SQLITE_ERROR` で断る
--   (5項までは通る。通常の SQLite の既定上限=500 よりずっと低い。README/ナレッジに記録)。
--   **複数行の `VALUES`** はこの上限に当たらない(0001/0004 の `popups_seed_triggers` と同じ構文)ので、
--   ここでも `VALUES` のテーブル式(列名は `column1`/`column2`/`column3`)を使う。
with site_source_popup as (
  select s.id as site_id,
    coalesce(
      (select p.id from popups p where p.site_id = s.id and p.status = 'active'),
      (select p.id from popups p where p.site_id = s.id and p.archived_at is null order by p.updated_at desc, p.id asc limit 1)
    ) as popup_id
  from sites s
),
kinds as (
  select column1 as kind, column2 as def_enabled, column3 as def_threshold from (values
    ('back',        1, null),
    ('scroll',      0, 50),
    ('idle',        0, 30),
    ('dwell',       0, 45),
    ('visibility',  0, null),
    ('exit_intent', 1, null)
  )
)
-- 🔴 `threshold` は **行があるかどうか**で既定値へ落とすかを決める(`coalesce` ではない)。
--   `threshold` 自体は null が正規の値(back/exit_intent/visibility の既定は null)なので、
--   「元の行が無い(= pt.popup_id is null)」と「元の行はあるが threshold が null」を
--   `coalesce(pt.threshold, k.def_threshold)` だけでは区別できない。
insert into site_display_triggers (owner_id, site_id, device, kind, enabled, threshold)
select s.owner_id, s.id, 'desktop', k.kind,
  coalesce(pt.enabled, k.def_enabled),
  case when pt.popup_id is not null then pt.threshold else k.def_threshold end
from sites s
cross join kinds k
left join site_source_popup ssp on ssp.site_id = s.id
left join popup_triggers pt on pt.popup_id = ssp.popup_id and pt.kind = k.kind;

-- mobile の値とモード(①②のポップの popup_mobile_display の値、③は既定値=desktop の写し・same_as_pc)
with site_source_popup as (
  select s.id as site_id,
    coalesce(
      (select p.id from popups p where p.site_id = s.id and p.status = 'active'),
      (select p.id from popups p where p.site_id = s.id and p.archived_at is null order by p.updated_at desc, p.id asc limit 1)
    ) as popup_id
  from sites s
)
insert into site_display_settings
  (owner_id, site_id, device, triggers_mode, frequency_mode,
   suppress_days, session_impressions, post_conversion_days, min_display_delay_seconds)
select s.owner_id, s.id, 'mobile',
  coalesce(pmd.triggers_mode, 'same_as_pc'),
  coalesce(pmd.frequency_mode, 'same_as_pc'),
  coalesce(pmd.suppress_days, coalesce(p.suppress_days, 7)),
  coalesce(pmd.session_impressions, coalesce(p.session_impressions, 1)),
  coalesce(pmd.post_conversion_days, coalesce(p.post_conversion_days, 30)),
  coalesce(pmd.min_display_delay_seconds, coalesce(p.min_display_delay_seconds, 3))
from sites s
left join site_source_popup ssp on ssp.site_id = s.id
left join popups p on p.id = ssp.popup_id
left join popup_mobile_display pmd on pmd.popup_id = ssp.popup_id;

-- mobile のトリガ6行(①②のポップの popup_mobile_triggers の値、③は既定値)
-- ⚠ 上と同じ理由で VALUES を使う(UNION ALL の6項は使わない)
with site_source_popup as (
  select s.id as site_id,
    coalesce(
      (select p.id from popups p where p.site_id = s.id and p.status = 'active'),
      (select p.id from popups p where p.site_id = s.id and p.archived_at is null order by p.updated_at desc, p.id asc limit 1)
    ) as popup_id
  from sites s
),
kinds as (
  select column1 as kind, column2 as def_enabled, column3 as def_threshold from (values
    ('back',        1, null),
    ('scroll',      0, 50),
    ('idle',        0, 30),
    ('dwell',       0, 45),
    ('visibility',  0, null),
    ('exit_intent', 1, null)
  )
)
-- 🔴 同じ理由で、threshold は「どの行が実際に一致したか」で分岐する(coalesce の入れ子にしない)。
insert into site_display_triggers (owner_id, site_id, device, kind, enabled, threshold)
select s.owner_id, s.id, 'mobile', k.kind,
  coalesce(pmt.enabled, coalesce(pt.enabled, k.def_enabled)),
  case
    when pmt.popup_id is not null then pmt.threshold
    when pt.popup_id is not null then pt.threshold
    else k.def_threshold
  end
from sites s
cross join kinds k
left join site_source_popup ssp on ssp.site_id = s.id
left join popup_mobile_triggers pmt on pmt.popup_id = ssp.popup_id and pmt.kind = k.kind
left join popup_triggers pt on pt.popup_id = ssp.popup_id and pt.kind = k.kind;
