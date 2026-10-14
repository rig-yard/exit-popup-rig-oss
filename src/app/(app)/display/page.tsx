"use client";

/*
  表示設定(新設)。
  🔴 サイト単位(1インストール=1サイトなので、実質このインストール全体の設定)。
    ポップの選択は無い。PC / スマホの切替も無い(画面から全廃)。
    デスクトップ(desktop)の行だけを読み書きする。
  🔴 原則「基本的に無駄なものは表示しない」: タイミングは**その端末(PC)で使えるものだけ**
    (`IMPLEMENTED_TRIGGERS` にあり、かつ desktop で使えるもの)を出す。説明文・注意書き・
    「1ページあたりの表示(固定)」「CV後は表示しない期間」(CV計測タグ未実装)は出さない。
  🔴 保存ボタンは無い——数値欄はblur・Enterで確定する(トグルは既定のまま即時保存)。未保存の
    状態を持たない(「保存」を押すまでの差分が無い)ので、この画面の離脱確認(`onBeforeLeave`・
    `UnsavedChangesDialog`)は無い。

  🔴 現在の設計は単純化したもの。
    かつての実装(デバウンス900ms・頻度だけ別の直列キュー)は、トリガのON/OFF・閾値・頻度それぞれが
    別々の経路でPUTしていたため、「閾値を確定した直後に古い値で上書きされる」
    「閾値がデバウンス待ちのまま離脱すると消える」「頻度のflushが新しい値を古い値で潰す」
    という穴が各箇所に残った。直した設計:
    - **デバウンスを撤去**。数値欄はblur・Enterのときだけ確定する(サイドバーを押すと、先に
      入力欄のblurが起きてから遷移が走る=ブラウザの標準動作なので、離脱前に確定が予約される。
      `_lib/displayAutosavePending.test.ts` で固定)。
    - **トリガのON/OFF・閾値・頻度の保存を、すべて同じ1本の直列キュー**(`_lib/singleFlightQueue.ts`)
      に通す。「待ち中の種類」(`pendingRef`。例: `threshold:dwell`・`frequency`・`toggle:scroll`)を
      1つのSetに集め、キューが1件ずつ排出する。送る内容は**その瞬間に`triggersRef`/`frequencyRef`
      から読む**(スケジュールした時点の値を持ち歩かない)——これで、混在する複数の確定が
      どんな順序で応答しても、古い値で上書きされない(`displayAutosavePending.test.ts`の
      「直す前(赤)→直した後(緑)」で再現と修正の両方を固定)。応答は入力中の値を上書きしない。
    - **アンマウント時のflushは撤去した**(ソフト遷移は同じ文書が続くので、通常のfetchは
      アンマウント後もそのまま完了する——止める理由が無い)。`pagehide`(タブを閉じる・外部へ
      移る)のときだけ、**待ち中(`pendingRef`)が空でなければ**keepaliveで送る。空なら何も
      送らない(dirtyでないのに送ると、別タブが書いた新しい値をこのタブの古い値で上書きする
      事故になりうるため)。
*/
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getJson, putJson, putJsonKeepalive } from "../../_lib/api";
import { ApiSiteDisplay, ApiTriggerKind } from "../../_lib/types";
import { Loading } from "../../_components/Loading";
import { ErrorBanner } from "../../_components/ErrorBanner";
import { useSessionState } from "../../_lib/sessionContext";
import { TAP_TARGET_44_V } from "../../_lib/a11y";
import { nextLoadErrorState } from "../../_lib/pageLoad";
import { toggleInSet } from "../../_lib/toggleSet";
import { createLatestWinsGuard, fetchLatestWins } from "../../_lib/latestWins";
import { createSingleFlightQueue, type SingleFlightQueue } from "../../_lib/singleFlightQueue";
import { FREQUENCY_RANGES } from "../../../lib/data/limits";
import { DEFAULT_THRESHOLDS, IMPLEMENTED_TRIGGERS, TRIGGER_DEVICES, TRIGGER_THRESHOLD_RANGE } from "../../../../packages/embed/src/bridge";

/** PC(desktop)でいま使えるタイミングだけ(「実装上の受け皿」と同じ表=`bridge.ts` を読む)。 */
const DESKTOP_TRIGGERS: readonly ApiTriggerKind[] = (["exit_intent", "dwell", "scroll"] as const).filter((kind) =>
  IMPLEMENTED_TRIGGERS.includes(kind) && TRIGGER_DEVICES[kind].includes("desktop"),
);

const TRIGGER_LABELS: Record<string, string> = {
  exit_intent: "画面外への退出",
  dwell: "滞在時間",
  scroll: "スクロール到達率",
};
const TRIGGER_UNIT: Record<string, string> = { dwell: "秒", scroll: "%" };

type TriggerState = { enabled: boolean; threshold: string };
type Frequency = { suppressDays: string; sessionImpressions: string; minDisplayDelaySeconds: string };

/** `FREQUENCY_RANGES`(DB の CHECK の写し)のキーごとの画面上の名前。 */
const FREQUENCY_FIELD_LABELS: Record<keyof typeof FREQUENCY_RANGES, string> = {
  suppressDays: "再表示しない日数",
  sessionImpressions: "セッション内の表示回数",
  minDisplayDelaySeconds: "最短表示待ち",
};

/** 待ち中の1件を表すキー。`"frequency"` または `` `toggle:${kind}` `` / `` `threshold:${kind}` ``。 */
type PendingId = string;
function toggleId(kind: ApiTriggerKind): PendingId {
  return `toggle:${kind}`;
}
function thresholdId(kind: ApiTriggerKind): PendingId {
  return `threshold:${kind}`;
}
const FREQUENCY_ID: PendingId = "frequency";

function DisplayContent() {
  const sessionState = useSessionState();
  const params = useSearchParams();
  const siteId = params.get("site") ?? "";

  const [loadError, setLoadError] = useState(false);
  const [reloadError, setReloadError] = useState(false);
  const loadedOnceRef = useRef(false);

  const [triggers, setTriggers] = useState<Record<string, TriggerState> | null>(null);
  const [frequency, setFrequency] = useState<Frequency | null>(null);
  // 🔴 送る瞬間に読む「今の最新値」。レンダーのクロージャ・スケジュール時点の値ではなく、
  //   常にここから読む(`sendOne`・`flushPendingNow`参照)。
  const triggersRef = useRef<Record<string, TriggerState> | null>(null);
  useEffect(() => {
    triggersRef.current = triggers;
  }, [triggers]);
  const frequencyRef = useRef<Frequency | null>(null);
  useEffect(() => {
    frequencyRef.current = frequency;
  }, [frequency]);
  // 🔴 キューの`run`は1度だけ作る安定した関数なので、siteIdもrefで読む(クロージャで固定しない)。
  const siteIdRef = useRef(siteId);
  useEffect(() => {
    siteIdRef.current = siteId;
  }, [siteId]);
  // 🔴 頻度の保存には「CV後は表示しない期間」も一緒に送る必要がある(PUT は4項目必須)。
  //   画面には出さない(CV計測タグ未実装で効かない値=)が、保存のたびに元の値をそのまま送り返す。
  const postConversionDaysRef = useRef(0);

  const [triggerError, setTriggerError] = useState<string | null>(null);
  // 🔴 項目ごとのエラー(控えめに示す。全体を覆うバナー・成功トーストは出さない)。
  const [frequencyFieldErrors, setFrequencyFieldErrors] = useState<Record<keyof Frequency, string | null>>({
    suppressDays: null,
    sessionImpressions: null,
    minDisplayDelaySeconds: null,
  });
  const [frequencySaving, setFrequencySaving] = useState(false);
  /*
    🔴 `toggleTrigger`(ON/OFFの切替。即時保存)のPUTが
    進行中でも進行中の集合に入っていなかった——PUT中でもサイドバー・ログアウトが即実行されていた
    (進行中のリクエストが中断される)。切替中のキー(kind)を集計する(ボタンのdisabledにも使う)。
  */
  const [togglingKinds, setTogglingKinds] = useState<ReadonlySet<string>>(new Set());

  // 🔴 ON/OFFの切替は「今どちらにしたいか」を別に持つ(確定するまで`triggers.enabled`自体は
  //   変えない——応答前に失敗しても画面の見た目が中途半端にならない。送る瞬間にここから読む)。
  const pendingTogglesRef = useRef<Map<string, boolean>>(new Map());

  // 🔴 待ち中の種類を1つのSetに集め、1本の直列キューが1件ずつ排出する(ファイル先頭のコメント参照)。
  const pendingRef = useRef<Set<PendingId>>(new Set());
  const queueRef = useRef<SingleFlightQueue | null>(null);
  function getQueue(): SingleFlightQueue {
    if (queueRef.current === null) queueRef.current = createSingleFlightQueue(processPendingOnce);
    return queueRef.current;
  }
  function schedule(id: PendingId) {
    pendingRef.current.add(id);
    void getQueue().trigger();
  }

  /**
   * `f` の3項目を検証する(副作用無しの純粋関数——エラーの反映は呼び出し側に任せる)。
   * 🔴 1項目でも範囲外なら `valid: false` を返す。**その項目を除いた残りだけ送る、ではなく
   *   全体を送らない**(無効な値をそのままサーバーへ送らない・有効な項目まで巻き込んで
   *   送信しないことの両方を兼ねる)。
   */
  function computeFrequencyPayload(
    f: Frequency,
  ): { valid: boolean; numbers: Record<string, number>; errors: Record<keyof Frequency, string | null> } {
    let allValid = true;
    const errors: Record<keyof Frequency, string | null> = { suppressDays: null, sessionImpressions: null, minDisplayDelaySeconds: null };
    for (const key of ["suppressDays", "sessionImpressions", "minDisplayDelaySeconds"] as const) {
      const range = FREQUENCY_RANGES[key];
      const raw = f[key];
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isInteger(value) || value < range.min || value > range.max) {
        errors[key] = `${FREQUENCY_FIELD_LABELS[key]}は${range.min}〜${range.max}の整数で入力してください。`;
        allValid = false;
      }
    }
    if (!allValid) return { valid: false, errors, numbers: {} };
    return {
      valid: true,
      errors,
      numbers: {
        suppressDays: Number(f.suppressDays),
        sessionImpressions: Number(f.sessionImpressions),
        postConversionDays: postConversionDaysRef.current,
        minDisplayDelaySeconds: Number(f.minDisplayDelaySeconds),
      },
    };
  }

  /** 範囲内の閾値だけを数値(またはnull=未指定→既定値)にする。副作用無し。 */
  function validateThreshold(kind: ApiTriggerKind, raw: string): { ok: true; resolved: number | null } | { ok: false } {
    const range = TRIGGER_THRESHOLD_RANGE[kind];
    if (range === undefined) return { ok: false };
    const value = raw.trim() === "" ? null : Number(raw);
    if (value !== null && (!Number.isInteger(value) || value < range.min || value > range.max)) return { ok: false };
    return { ok: true, resolved: value ?? DEFAULT_THRESHOLDS[kind] ?? null };
  }

  async function sendFrequency() {
    if (frequencyRef.current === null) return;
    const payload = computeFrequencyPayload(frequencyRef.current);
    setFrequencyFieldErrors((prev) => ({ ...prev, ...payload.errors }));
    if (!payload.valid) return; // 無効な項目がある間は送らない
    setFrequencySaving(true);
    // 🔴 直列キューが送るPUTは全部`keepalive:true`(pagehide中の送信中断を防ぐ。ファイル先頭のコメント参照)。
    const result = await putJson<null>(`/sites/${siteIdRef.current}/display/desktop/frequency`, payload.numbers, { keepalive: true });
    setFrequencySaving(false);
    if (!result.ok) {
      setFrequencyFieldErrors((prev) => ({ ...prev, suppressDays: prev.suppressDays ?? "保存できませんでした。もう一度お試しください。" }));
    }
    // 🔴 成功しても`frequency`(入力中の値)は一切上書きしない。送った値=入力中の値なので、
    //   これ以上「baselineに反映する」ための別の状態は要らない。
  }

  async function sendToggle(kind: ApiTriggerKind) {
    const desired = pendingTogglesRef.current.get(kind);
    pendingTogglesRef.current.delete(kind);
    if (desired === undefined) return;
    setTriggerError(null);
    const result = await putJson<null>(`/sites/${siteIdRef.current}/display/desktop/triggers/${kind}`, { enabled: desired }, { keepalive: true });
    setTogglingKinds((prev) => toggleInSet(prev, kind, false));
    if (!result.ok) {
      setTriggerError("切り替えられませんでした。もう一度お試しください。");
      return;
    }
    // 🔴 トグルは`togglingKinds`で保存中disabledにしており、送った`desired`と同じkindへの
    //   別の入力は保存が終わるまで起こり得ない(スイッチの位置自体が`入力中の値`そのもので、
    //   これを送った値で確定するのは上書きにならない)。閾値のような「文字入力中のまま応答が
    //   届く」経路が無い。
    setTriggers((prev) => (prev ? { ...prev, [kind]: { ...prev[kind], enabled: desired } } : prev));
  }

  async function sendThreshold(kind: ApiTriggerKind) {
    if (triggersRef.current === null) return;
    const raw = triggersRef.current[kind].threshold; // 🔴 送る瞬間の最新値(スケジュール時点ではない)
    const validated = validateThreshold(kind, raw);
    if (!validated.ok) {
      setTriggerError(`${TRIGGER_LABELS[kind]}は${TRIGGER_THRESHOLD_RANGE[kind]?.min}〜${TRIGGER_THRESHOLD_RANGE[kind]?.max}の整数で入力してください。`);
      return;
    }
    setTriggerError(null);
    const result = await putJson<null>(
      `/sites/${siteIdRef.current}/display/desktop/triggers/${kind}/threshold`,
      { threshold: validated.resolved },
      { keepalive: true },
    );
    if (!result.ok) {
      setTriggerError("保存できませんでした。もう一度お試しください。");
      return;
    }
    // 🔴 以前はここで応答の確定値(未指定時は
    //   既定値に解決した文字列)を`triggers[kind].threshold`(=入力欄の表示値)へ書き戻していた。
    //   応答が届くまでの間にユーザーが同じ欄へ別の値を入力していた場合、その入力中の文字が
    //   応答のタイミングで古い(送信した時点の)値に上書きされる——頻度で直した「応答で入力中の
    //   値を上書きしない」原則が、閾値だけ抜けていた。**成功しても入力欄には一切触れない**
    //   (未指定→既定値に解決したことを画面に反映する必要はない。次にこの欄をblurすれば、
    //   その時点の最新の入力でまた検証・送信される)。
  }

  async function sendOne(id: PendingId) {
    if (id === FREQUENCY_ID) {
      await sendFrequency();
    } else if (id.startsWith("toggle:")) {
      await sendToggle(id.slice("toggle:".length) as ApiTriggerKind);
    } else if (id.startsWith("threshold:")) {
      await sendThreshold(id.slice("threshold:".length) as ApiTriggerKind);
    }
  }

  /** 1本の直列キューが呼ぶ唯一の`run`。待ち中が空になるまで1件ずつ排出する(並行送信しない)。 */
  async function processPendingOnce() {
    while (pendingRef.current.size > 0) {
      const id = pendingRef.current.values().next().value as PendingId;
      pendingRef.current.delete(id);
      await sendOne(id);
    }
  }

  /**
   * `pagehide`(タブを閉じる・外部へ移る)のときだけ呼ぶ。**待ち中が無ければ何もしない**
   * (dirtyでないのに送ると、別タブが書いた新しい値をこのタブの古い値で上書きする事故になりうる)。
   * ある場合だけ、`keepalive`のfetchでそのまま送る(応答は見ない。ページはもう離脱している)。
   * 🔴 コンポーネントのアンマウント(ソフト遷移で他のページへ移る)では呼ばない——同じ文書が
   *   続くので、`processPendingOnce`が発行した通常のfetchはアンマウント後もそのまま完了する。
   * ⚠ 既知の制限: ここで送るのは`pendingRef`(まだ`sendOne`が読んでいない=未送信)の分だけ。
   *   `processPendingOnce`が既にある項目を読んで送信中(応答待ち)のところへ`pagehide`が重なる、
   *   という稀な競合は扱わない(その送信自体は`keepalive:true`なので中断されない=取りこぼしは
   *   起きないが、ここでの二重送信もしない、というだけの意味)。
   */
  function flushPendingNow() {
    if (pendingRef.current.size === 0) return;
    for (const id of pendingRef.current) {
      if (id === FREQUENCY_ID) {
        if (frequencyRef.current === null) continue;
        const payload = computeFrequencyPayload(frequencyRef.current);
        if (payload.valid) putJsonKeepalive(`/sites/${siteIdRef.current}/display/desktop/frequency`, payload.numbers);
      } else if (id.startsWith("threshold:")) {
        const kind = id.slice("threshold:".length) as ApiTriggerKind;
        if (triggersRef.current === null) continue;
        const validated = validateThreshold(kind, triggersRef.current[kind].threshold);
        if (validated.ok) putJsonKeepalive(`/sites/${siteIdRef.current}/display/desktop/triggers/${kind}/threshold`, { threshold: validated.resolved });
      } else if (id.startsWith("toggle:")) {
        const kind = id.slice("toggle:".length);
        const desired = pendingTogglesRef.current.get(kind);
        if (desired !== undefined) putJsonKeepalive(`/sites/${siteIdRef.current}/display/desktop/triggers/${kind}`, { enabled: desired });
      }
    }
    pendingRef.current.clear();
  }
  useEffect(() => {
    window.addEventListener("pagehide", flushPendingNow);
    return () => window.removeEventListener("pagehide", flushPendingNow);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- flushPendingNowはrefから最新値を読むので安定でなくてよい
  }, []);

  // 🔴 `DisplayPage`(下)が `site` が変わるたびに `key` で丸ごと作り直すので、「違うサイトの
  //   応答がこの画面に紛れ込む」ことは無くなった。ここでは**同じsite**のまま再読み込みボタンの
  //   連打等で`load()`が重複発行されたときに、古い応答が新しい応答を上書きしないようにする
  //   (`popups/page.tsx`・`popup/page.tsx`と同じ考え方)。
  const loadGuardRef = useRef(createLatestWinsGuard());
  const load = useCallback(async () => {
    if (siteId === "") return;
    await fetchLatestWins(
      loadGuardRef.current,
      () => getJson<ApiSiteDisplay>(`/sites/${siteId}/display`),
      () => {},
      (result) => {
        const next = nextLoadErrorState(result.ok, loadedOnceRef.current);
        setLoadError(next.loadError);
        setReloadError(next.reloadError);
        if (!result.ok) return;
        loadedOnceRef.current = true;
        const desktop = result.data.desktop;
        postConversionDaysRef.current = desktop.postConversionDays;
        const nextFrequency: Frequency = {
          suppressDays: String(desktop.suppressDays),
          sessionImpressions: String(desktop.sessionImpressions),
          minDisplayDelaySeconds: String(desktop.minDisplayDelaySeconds),
        };
        setFrequency(nextFrequency);
        const nextTriggers: Record<string, TriggerState> = {};
        for (const kind of DESKTOP_TRIGGERS) {
          const t = desktop.triggers.find((x) => x.kind === kind);
          const threshold = t?.threshold !== null && t?.threshold !== undefined ? String(t.threshold) : "";
          nextTriggers[kind] = { enabled: t?.enabled ?? false, threshold };
        }
        setTriggers(nextTriggers);
      },
    );
  }, [siteId]);

  useEffect(() => {
    if (sessionState === "ready") void load();
  }, [sessionState, load]);

  function toggleTrigger(kind: ApiTriggerKind) {
    if (triggers === null) return;
    // 🔴 同じトグルを保存中にもう一度押すと、PUTが並行して走ることになるため、ボタンを
    //   disabled にして見た目でも分かるようにする(下のJSX)のに加え、関数自体にも入り口で止める。
    if (togglingKinds.has(kind)) return;
    const desired = !triggers[kind].enabled;
    setTriggerError(null);
    setTogglingKinds((prev) => toggleInSet(prev, kind, true));
    pendingTogglesRef.current.set(kind, desired);
    schedule(toggleId(kind));
  }

  return (
    // 🔴 サイドバー(AppShell)は `(app)/layout.tsx` が1回だけ描く。ここはその中身(children)だけ。
    <>
      {siteId === "" ? (
        <ErrorBanner message="サイトが指定されていません。" />
      ) : sessionState !== "ready" ? (
        <Loading label="確認中" />
      ) : (
        <>
          {loadError && <ErrorBanner message="取得できませんでした。もう一度お試しください。" onRetry={load} retryLabel="再読み込み" />}
          {reloadError && (
            <div className="mb-6">
              <ErrorBanner message="最新の状態を読み込めませんでした" onRetry={load} retryLabel="再読み込み" />
            </div>
          )}
          {(triggers === null || frequency === null) && !loadError && <Loading label="表示設定を読み込み中" />}

          {triggers !== null && frequency !== null && (
            <section className="rounded-xl border border-line bg-surface p-6">
          <div className="mb-8">
            <h2 className="mb-3 text-sm font-semibold text-ink">タイミング</h2>
            {triggerError && (
              <p role="alert" className="mb-3 text-xs font-medium text-danger">
                {triggerError}
              </p>
            )}
            <div className="rounded-lg border border-line divide-y divide-line">
              {DESKTOP_TRIGGERS.map((kind) => {
                const t = triggers[kind];
                const range = TRIGGER_THRESHOLD_RANGE[kind];
                return (
                  <div key={kind} className="flex items-center justify-between gap-4 px-4 py-3">
                    <div className="text-sm font-medium text-ink">{TRIGGER_LABELS[kind]}</div>
                    <div className="flex items-center gap-4">
                      {range !== undefined && (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            aria-label={`${TRIGGER_LABELS[kind]}の閾値`}
                            min={range.min}
                            max={range.max}
                            value={t.threshold}
                            onChange={(e) =>
                              setTriggers((prev) => (prev ? { ...prev, [kind]: { ...prev[kind], threshold: e.target.value } } : prev))
                            }
                            onBlur={() => schedule(thresholdId(kind))}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              schedule(thresholdId(kind));
                            }}
                            className="w-20 rounded-lg border border-line bg-surface px-2.5 h-9 text-sm text-ink font-mono
                                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
                          />
                          <span className="text-sm text-ink/60">{TRIGGER_UNIT[kind]}</span>
                        </div>
                      )}
                      <button
                        type="button"
                        role="switch"
                        aria-checked={t.enabled}
                        aria-label={`${TRIGGER_LABELS[kind]}を有効にする`}
                        disabled={togglingKinds.has(kind)}
                        onClick={() => toggleTrigger(kind)}
                        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors motion-reduce:transition-none
                                    focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                                    disabled:opacity-60 ${TAP_TARGET_44_V} ${t.enabled ? "bg-ink" : "bg-line"}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-paper transition-transform motion-reduce:transition-none
                                      ${t.enabled ? "translate-x-5" : "translate-x-0"}`}
                        />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="mb-8">
            <h2 className="mb-3 text-sm font-semibold text-ink">頻度</h2>
            {/*
              🔴 自動保存(保存ボタンは無い)。blur・Enterで確定(デバウンスは撤去した)。
              エラー・保存中は項目の下に控えめに出す(全体を覆うバナー・成功トーストは
              出さない=「無駄なものは表示しない」)。
            */}
            <div className="grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2 max-w-xl">
              <FrequencyFieldInput
                id="suppress-days"
                label="再表示しない日数"
                unit="日"
                value={frequency.suppressDays}
                error={frequencyFieldErrors.suppressDays}
                saving={frequencySaving}
                range={FREQUENCY_RANGES.suppressDays}
                onChangeValue={(v) => setFrequency({ ...frequency, suppressDays: v })}
                commit={() => schedule(FREQUENCY_ID)}
              />
              <FrequencyFieldInput
                id="session-impressions"
                label="セッション内の表示回数"
                unit="回"
                value={frequency.sessionImpressions}
                error={frequencyFieldErrors.sessionImpressions}
                saving={frequencySaving}
                range={FREQUENCY_RANGES.sessionImpressions}
                onChangeValue={(v) => setFrequency({ ...frequency, sessionImpressions: v })}
                commit={() => schedule(FREQUENCY_ID)}
              />
              <FrequencyFieldInput
                id="min-delay"
                label="最短表示待ち"
                unit="秒"
                value={frequency.minDisplayDelaySeconds}
                error={frequencyFieldErrors.minDisplayDelaySeconds}
                saving={frequencySaving}
                range={FREQUENCY_RANGES.minDisplayDelaySeconds}
                onChangeValue={(v) => setFrequency({ ...frequency, minDisplayDelaySeconds: v })}
                commit={() => schedule(FREQUENCY_ID)}
              />
            </div>
          </div>
        </section>
          )}
        </>
      )}
    </>
  );
}

/** 頻度の数値欄1つ(自動保存。ラベル・単位・エラー・保存中の表示を1か所にまとめる)。 */
function FrequencyFieldInput({
  id,
  label,
  unit,
  value,
  error,
  saving,
  range,
  onChangeValue,
  commit,
}: {
  id: string;
  label: string;
  unit: string;
  value: string;
  error: string | null;
  saving: boolean;
  range: { min: number; max: number };
  onChangeValue: (value: string) => void;
  commit: () => void;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          min={range.min}
          max={range.max}
          value={value}
          onChange={(e) => onChangeValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            commit();
          }}
          aria-invalid={error !== null}
          aria-describedby={error !== null ? `${id}-error` : undefined}
          className="w-24 rounded-lg border border-line bg-surface px-3.5 h-10 text-sm text-ink font-mono
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
        />
        <span className="text-sm text-ink/60">{unit}</span>
        {saving && (
          <span className="text-xs text-ink/50" aria-live="polite">
            保存中…
          </span>
        )}
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/*
  🔴 `?site=` が変わっても(同じ`/display`ルートへのソフト遷移)、`DisplayContent` は同じ
  コンポーネントインスタンスのまま再利用され、前のサイトの入力・待ち中の保存予約が残る。
  `key={siteId}` で、siteが変わったら丸ごと作り直す(`popup/page.tsx`と同じ)。
*/
function DisplaySiteGate() {
  const params = useSearchParams();
  const siteId = params.get("site") ?? "";
  return <DisplayContent key={siteId} />;
}

export default function DisplayPage() {
  return (
    <Suspense fallback={null}>
      <DisplaySiteGate />
    </Suspense>
  );
}
