"use client";

/*
  左サイドバー。
  4項目: ダッシュボード / デザイン / 表示設定 / タグの設置。
  🔴 1インストール=1サイトなので、サイトの切り替え・「サイトを追加」・
    サイト名は出さない。下部の「タグの設置」案内カードも撤去。
  🔴 WORKSPACE(訂正済みの用語): 管理画面を使うチーム・組織の単位(owner 1人に1。サイトとは別のデータ)。
    切り替えは無く、名前だけを表示する。キャンペーン名(popup/page.tsx)と同じ作法で、
    鉛筆を押したときだけ入力になる(ふだんは表示だけ)。
*/
import { useRef, useState } from "react";
import { postJson, putJson } from "../_lib/api";
import { clearAllPopupEditSnapshots } from "../_lib/popupEditSession";
import type { ApiWorkspace } from "../_lib/types";
import { armGlobalBeforeUnloadBypass, type LeaveGuard } from "../_lib/unsavedChanges";
import { clearCachedWorkspaceName } from "../_lib/workspaceCache";
import { GuardedLink } from "./GuardedLink";
import { CheckIcon, EditIcon, IconButton, XIcon } from "./IconButton";

export const BRAND = "EXIT POPUP - RIG";

export type NavKey = "dashboard" | "design" | "display" | "tags";

const NAV_ITEMS: Array<{ key: NavKey; label: string; href: (siteId: string) => string; icon: React.ReactNode }> = [
  {
    key: "dashboard",
    label: "ダッシュボード",
    href: (siteId) => `/dashboard?site=${siteId}`,
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="11" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="11" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
        <rect x="11" y="11" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    key: "design",
    label: "デザイン",
    href: (siteId) => `/popups?site=${siteId}`,
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <rect x="3" y="4" width="14" height="12" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 8h8M6 11h5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    key: "display",
    label: "表示設定",
    href: (siteId) => `/display?site=${siteId}`,
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M3 6h7M13 6h4M3 14h4M10 14h7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="10" cy="6" r="1.6" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="7" cy="14" r="1.6" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    ),
  },
  {
    key: "tags",
    label: "タグの設置",
    href: (siteId) => `/tags?site=${siteId}`,
    icon: (
      <svg className="h-4 w-4" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M7 6L3 10l4 4M13 6l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
];

function NavLink({
  item,
  active,
  siteId,
  onBeforeLeave,
  onNavigate,
}: {
  item: (typeof NAV_ITEMS)[number];
  active: boolean;
  siteId: string;
  onBeforeLeave?: LeaveGuard;
  onNavigate?: () => void;
}) {
  /*
    🔴 キャンペーン詳細(`popup/page.tsx`)は、本体の取得が終わって
    `popup.siteId` が分かるまでサイトが確定しない。未確認のURLの手がかり(`?site=`)で
    リンク先を組み立てると、取得に失敗した場合に誤ったサイトへのリンクが残ってしまう。
    呼び出し側は確定していない間 `siteId=""` を渡すので、ここでは非活性の表示にする
    (href を持たない=クリックしても何も起きない。確定したら通常のリンクに戻る)。
  */
  if (siteId === "") {
    return (
      <span aria-disabled="true" className="flex h-11 cursor-not-allowed items-center gap-2.5 rounded-lg px-3.5 text-sm font-semibold text-ink/30">
        {item.icon}
        {item.label}
      </span>
    );
  }
  const href = item.href(siteId);
  return (
    <GuardedLink
      href={href}
      aria-current={active ? "page" : undefined}
      onBeforeLeave={onBeforeLeave}
      onBeforeNavigate={onNavigate}
      className={`flex h-11 items-center gap-2.5 rounded-lg px-3.5 text-sm font-semibold
                  focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink
                  ${active ? "bg-ink text-paper" : "text-ink/70 hover:bg-paper"}`}
    >
      {item.icon}
      {item.label}
    </GuardedLink>
  );
}

/**
 * WORKSPACE名(Slack のワークスペースと同じ概念。切り替えは無く、名前だけ)。
 * キャンペーン名(popup/page.tsx の見出し)と同じ作法: 鉛筆を押したときだけ入力になる。
 * 🔴 `workspace`/`loadError` は親(AppShell)が1回だけ取得して渡す(デスクトップ+ドロワーの
 *   2箇所に同じ `SidebarContent` を描くため、ここで個別に取得すると二重に読みに行く)。
 */
function WorkspaceName({
  workspace,
  loadError,
  onRenamed,
  sessionReady,
}: {
  workspace: ApiWorkspace | null;
  loadError: boolean;
  onRenamed: (name: string) => void;
  /** 🔴 `/session` の確認が済むまで編集を始めさせない。 */
  sessionReady: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEdit() {
    if (workspace === null || !sessionReady) return;
    setValue(workspace.name);
    setError(null);
    setEditing(true);
  }

  function cancel() {
    setEditing(false);
    setError(null);
  }

  async function save() {
    const trimmed = value.trim();
    if (trimmed === "" || saving) return;
    setSaving(true);
    const result = await putJson<null>("/workspace/name", { name: trimmed });
    setSaving(false);
    if (!result.ok) {
      setError("保存できませんでした。もう一度お試しください。");
      return;
    }
    onRenamed(trimmed);
    setEditing(false);
  }

  return (
    <div className="mb-5">
      <span className="mb-1 block text-[11px] font-semibold tracking-wide text-ink/50">WORKSPACE</span>
      {error && (
        <p role="alert" className="mb-1 text-xs font-medium text-danger">
          {error}
        </p>
      )}
      {/*
        🔴 ページを移るたびに一瞬「読み込み中…」になっていた
        (静的書き出しはページごとに再マウントされ、毎回 `GET /workspace` を取り直すため)。
        AppShell.tsx がタブ内キャッシュ(sessionStorage)から前回の名前を初期値に入れるので、
        ここは「`workspace` があれば出す」だけでよい。`loadError` は**名前を1つも持っていない
        とき**(キャッシュも無い初回アクセスで失敗した)だけ出す——キャッシュ済みの名前がある間に
        裏の再取得が失敗しても、その古い名前を黙って消して「取得できませんでした」に差し替えない
        (直前まで見えていた値を失敗で消すほうが利用者には分かりにくい)。
        初回でまだ何も無い間(`workspace===null && !loadError`)は「読み込み中…」の文字を出さず
        空白にする(すぐ裏で取り直すため、文字が入れ替わるより先に空白→実名の方が自然)。
      */}
      {workspace === null && loadError ? (
        <span className="text-sm text-danger">取得できませんでした</span>
      ) : !editing ? (
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{workspace?.name ?? ""}</span>
          {workspace !== null && (
            <IconButton as="button" label="WORKSPACE名を編集" icon={EditIcon} disabled={!sessionReady} onClick={startEdit} />
          )}
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <label htmlFor="workspace-name-input" className="sr-only">
            WORKSPACE名
          </label>
          <input
            id="workspace-name-input"
            type="text"
            value={value}
            disabled={saving}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
              if (e.key === "Escape") cancel();
            }}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-semibold text-ink
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          />
          <IconButton as="button" label="保存" icon={CheckIcon} disabled={saving || value.trim() === ""} onClick={() => void save()} />
          <IconButton as="button" label="キャンセル" icon={XIcon} disabled={saving} onClick={cancel} />
        </div>
      )}
    </div>
  );
}

function AccountMenu({ onBeforeLeave, sessionReady }: { onBeforeLeave?: LeaveGuard; sessionReady: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const submittingRef = useRef(false);

  async function doLogout(): Promise<boolean> {
    submittingRef.current = true;
    setError(null);
    const result = await postJson("/logout", {});
    if (result.ok || result.status === 401) {
      // 🔴 ここで消さないと、同じタブで再度ログインしたとき新しいGETが
      //   終わるまでの一瞬、前のセッションのWORKSPACE名が見えてしまう。
      clearCachedWorkspaceName();
      clearAllPopupEditSnapshots();
      armGlobalBeforeUnloadBypass();
      window.location.href = "/login";
      return true;
    }
    submittingRef.current = false;
    setError("ログアウトできませんでした。もう一度お試しください。");
    return false;
  }

  function handleClick() {
    // 🔴 `/session` の確認が済むまで `POST /logout` を呼ばない
    //   (未確認の間に「ログイン済みかどうか」に依存するAPIを叩く理由が無い)。
    if (!sessionReady || submittingRef.current) return;
    if (onBeforeLeave) onBeforeLeave(doLogout);
    else void doLogout();
  }

  return (
    <div className="border-t border-line pt-4">
      {error && (
        <p role="alert" className="mb-2 text-xs font-medium text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-paper text-xs font-semibold text-ink/60" aria-hidden="true">
          A
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-ink">管理者</div>
          <button
            type="button"
            disabled={!sessionReady}
            onClick={handleClick}
            className="text-xs text-ink/60 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink"
          >
            ログアウト
          </button>
        </div>
      </div>
    </div>
  );
}

export function SidebarContent({
  activeNav,
  siteId,
  workspace,
  workspaceLoadError,
  onWorkspaceRenamed,
  onBeforeLeave,
  sessionReady,
  onNavigate,
}: {
  activeNav: NavKey;
  siteId: string;
  workspace: ApiWorkspace | null;
  workspaceLoadError: boolean;
  onWorkspaceRenamed: (name: string) => void;
  onBeforeLeave?: LeaveGuard;
  /** `useRequireSession()` が `"ready"` になったか。確認前はWORKSPACE編集・ログアウトを押せない。 */
  sessionReady: boolean;
  /** ドロワーでリンクを押したあとに閉じるためのコールバック(デスクトップ版では渡さない)。 */
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="mb-5 flex items-center gap-2">
        <span className="inline-block h-5 w-5 rounded-md bg-ink" aria-hidden="true"></span>
        <span className="text-sm font-semibold tracking-tight">{BRAND}</span>
      </div>

      <WorkspaceName workspace={workspace} loadError={workspaceLoadError} onRenamed={onWorkspaceRenamed} sessionReady={sessionReady} />

      <nav aria-label="メインメニュー" className="flex flex-col gap-1">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.key}
            item={item}
            active={item.key === activeNav}
            siteId={siteId}
            onBeforeLeave={onBeforeLeave}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="flex-1" />

      <AccountMenu onBeforeLeave={onBeforeLeave} sessionReady={sessionReady} />
    </div>
  );
}
