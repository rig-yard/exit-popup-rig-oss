/*
  表示設定の頻度3項目は1本のPUTで4項目まとめて送る必要があるため、
  項目ごとに個別にPUTすると、応答の順序が入れ替わったときに**後から確定した値が、先に確定した
  (が後から応答が届いた)値で上書きされて消える**(`display/page.tsx` の `commitFrequency` 参照)。

  この「同時に2本走らせない・待っている間にもう一度呼ばれたら、終わったら最新の状態でもう一度だけ
  実行する」という直列化のパターンを、DOM・React に依存しない純粋なプリミティブとして切り出す
  (このリポジトリの作法=`variantSync.ts`・`pageLoad.ts`と同じ。描画検査を持たないため、
  ロジックを単体テストできる形に外へ出す)。

  🔴 `run` 自身は「今の最新の状態」を**呼ばれた瞬間に**読む(クロージャ・refのどちらでもよいが、
  呼び出し側が毎回最新を読むように書く責任を持つ)。このキュー自体は「いつ呼ぶか」だけを
  直列化し、「何を送るか」には関与しない。
*/
export type SingleFlightQueue = {
  /** 呼ぶたびに「実行したい」という意思を1つ記録する。既に実行中なら、終わった後にもう一度だけ`run`を呼ぶ。 */
  trigger: () => Promise<void>;
  /** 今まさに`run`が実行中か(テスト・デバッグ用)。 */
  isRunning: () => boolean;
};

export function createSingleFlightQueue(run: () => Promise<void>): SingleFlightQueue {
  let running = false;
  let pendingRerun = false;

  async function trigger(): Promise<void> {
    if (running) {
      pendingRerun = true;
      return;
    }
    running = true;
    try {
      await run();
    } finally {
      running = false;
    }
    if (pendingRerun) {
      pendingRerun = false;
      await trigger();
    }
  }

  return { trigger, isRunning: () => running };
}
