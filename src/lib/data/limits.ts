/*
  件数の上限。**効かせているのは DB のトリガ**(db/migrations/0001_schema.sql)。
  ここは画面に出すための写しで、`tests/d1-limits.test.ts` が**トリガの実際の振る舞い**と突き合わせる。
  ⚠ 「頻度ルール 10」は取り下げ(数える行が無いため)。
  🔴 sites は 1(「1インストール=1サイト」)。実際に効くのは
  `sites_single`(db/migrations/0006_sites_single_per_owner.sql)で、旧来の `sites_limit`(20)は
  残したまま(より厳しい規則が先に断る)。
*/
export const LIMITS = {
  sites: 1,
  popupsPerSite: 50,
  variantsPerPopup: 5,
} as const;

export type LimitTarget = keyof typeof LIMITS;

/*
  頻度(表示設定)の各数値の範囲。**効かせているのは DB の CHECK**
  (db/migrations/0005_site_display_settings.sql の `site_display_settings`)。ここは画面に出すための
  写し(画面側に上限が無く、サーバーの32767を超えた入力を
  「保存できませんでした」としか言えていなかった。欄ごとの範囲を画面にも持って事前に検査する)。
*/
export const FREQUENCY_RANGES = {
  suppressDays: { min: 0, max: 32767 },
  sessionImpressions: { min: 1, max: 32767 },
  minDisplayDelaySeconds: { min: 0, max: 32767 },
} as const;
