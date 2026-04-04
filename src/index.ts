#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getPosts,
  getTags,
  getAllGameCategoryIds,
  getCategoryIdsByCompetition,
  getCategoryIdsBySeason,
  getAvailableSeasons,
} from "./wordpress-client.js";
import { parseMatchInfo, htmlToMarkdown, stripHtml, HOME_TEAM_NAME } from "./parser.js";
import type { MatchInfo } from "./parser.js";

const server = new McpServer({
  name: "anclas-mcp-server",
  version: "1.0.0",
});

/** MCP textレスポンスのヘルパー */
function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** エラーレスポンスのヘルパー */
function errorResponse(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

/** Markdownインジェクション防止: ユーザー入力をバッククォートで囲む */
function sanitizeInput(input: string): string {
  return `\`${input.replace(/`/g, "")}\``;
}

/** 公式サイトの試合告知投稿はタイトルか本文にこれらのキーワードを含む傾向がある */
const UPCOMING_MATCH_KEYWORDS = ["開幕", "試合情報", "マッチデー", "Kick off", "キックオフ"];
/** チーム名の後に数字とハイフンが続く＝試合結果が記載済み */
const SCORE_RESULT_PATTERN = new RegExp(HOME_TEAM_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`\s*\d+\s*[(\-–]`);
const BLOG_EXCERPT_MAX_CHARS = 1000;
const NEWS_EXCERPT_MAX_CHARS = 200;

/** 勝点計算の定数 */
const POINTS_PER_WIN = 3;

/** 記事のサマリーをフォーマットする共通ヘルパー */
function formatArticleSummary(post: { title: { rendered: string }; date: string; link: string; excerpt: { rendered: string } }, excerptMaxChars: number): string {
  const title = stripHtml(post.title.rendered);
  const excerpt = stripHtml(post.excerpt.rendered).slice(0, excerptMaxChars);
  return `### ${title}\n*${post.date.split("T")[0]}* | ${post.link}\n\n${excerpt}`;
}

/** シーズン成績を集計する */
function aggregateSeasonResults(posts: { title: { rendered: string }; content: { rendered: string }; link: string }[]): {
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  matchSummaries: string[];
} {
  let wins = 0,
    draws = 0,
    losses = 0;
  let goalsFor = 0,
    goalsAgainst = 0;
  const matchSummaries: string[] = [];

  for (const post of posts) {
    const title = stripHtml(post.title.rendered);
    const info = parseMatchInfo(title, post.content.rendered);

    if (!info.score) continue;

    const { anclasGoals, opponentGoals } = info.score;
    goalsFor += anclasGoals;
    goalsAgainst += opponentGoals;
    if (anclasGoals > opponentGoals) wins++;
    else if (anclasGoals === opponentGoals) draws++;
    else losses++;

    matchSummaries.push(
      `${info.date ?? "?"} | ${info.homeTeam} ${info.scoreDisplay} ${info.awayTeam ?? "?"} | ${info.scorers.length > 0 ? info.scorers.join(", ") : "-"}`,
    );
  }

  return { wins, draws, losses, goalsFor, goalsAgainst, matchSummaries };
}

// ─── get_next_match ─────────────────────────────────────────
server.tool(
  "get_next_match",
  "次の試合情報を取得する。日時・対戦相手・会場・キックオフ時間を返す。",
  {},
  async () => {
    try {
      const posts = await getPosts({ perPage: 30, order: "desc" });

      for (const post of posts) {
        const title = stripHtml(post.title.rendered);
        const content = stripHtml(post.content.rendered);
        const combined = title + " " + content;

        const isAnnouncement = UPCOMING_MATCH_KEYWORDS.some((kw) => combined.includes(kw));
        const hasScore = SCORE_RESULT_PATTERN.test(content);

        if (isAnnouncement && !hasScore) {
          const info = parseMatchInfo(title, post.content.rendered);
          return textResponse(
            [
              `## 次の試合`,
              `- **大会**: ${info.competition ?? "不明"}`,
              `- **日時**: ${info.date ?? "未定"} ${info.kickoff ? info.kickoff + " Kick off" : ""}`,
              `- **対戦**: ${info.homeTeam} vs ${info.awayTeam ?? "未定"}`,
              `- **会場**: ${info.venue ?? "未定"}`,
              `- **詳細**: ${post.link}`,
            ].join("\n"),
          );
        }
      }

      // フォールバック: 試合カテゴリの最新投稿から推定
      const allCatIds = await getAllGameCategoryIds();
      const gamePosts = await getPosts({ categories: allCatIds, perPage: 1, order: "desc" });
      if (gamePosts.length > 0) {
        const post = gamePosts[0];
        const title = stripHtml(post.title.rendered);
        const info = parseMatchInfo(title, post.content.rendered);
        return textResponse(
          [
            `## 直近の試合情報`,
            `（次の試合の告知が見つからなかったため、最新の試合レポートを表示）`,
            `- **大会**: ${info.competition ?? "不明"}`,
            `- **日時**: ${info.date ?? "不明"}`,
            `- **対戦**: ${info.homeTeam} vs ${info.awayTeam ?? "不明"}`,
            `- **スコア**: ${info.scoreDisplay ?? "不明"}`,
            `- **詳細**: ${post.link}`,
          ].join("\n"),
        );
      }

      return textResponse("試合情報が見つかりませんでした。");
    } catch (e) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", message: "get_next_match failed", context: { error: e instanceof Error ? e.message : String(e) } }));
      return errorResponse("試合情報の取得に失敗しました。しばらく経ってから再度お試しください。");
    }
  },
);

// ─── get_recent_matches ─────────────────────────────────────
server.tool(
  "get_recent_matches",
  "直近の試合結果を取得する。スコア・得点者・対戦相手を一覧で返す。",
  {
    count: z.number().min(1).max(20).default(5).describe("取得する試合数（デフォルト5）"),
    competition: z
      .string()
      .default("all")
      .describe("大会でフィルタ（例: all, Qリーグ, なでしこリーグ, 皇后杯）"),
  },
  async ({ count, competition }) => {
    try {
      const categoryIds =
        competition === "all"
          ? await getAllGameCategoryIds()
          : await getCategoryIdsByCompetition(competition);

      const posts = await getPosts({ categories: categoryIds, perPage: count, order: "desc" });

      if (posts.length === 0) {
        return textResponse("試合結果が見つかりませんでした。");
      }

      const results = posts.map((post) => {
        const title = stripHtml(post.title.rendered);
        const info = parseMatchInfo(title, post.content.rendered);
        const lines = [
          `### ${title}`,
          `- **日時**: ${info.date ?? "不明"}`,
          `- **対戦**: ${info.homeTeam} vs ${info.awayTeam ?? "不明"}`,
        ];
        if (info.scoreDisplay) lines.push(`- **スコア**: ${info.scoreDisplay}${info.halfTimeScore ? ` (${info.halfTimeScore})` : ""}`);
        if (info.scorers.length > 0) lines.push(`- **得点者**: ${info.scorers.join(", ")}`);
        if (info.venue) lines.push(`- **会場**: ${info.venue}`);
        lines.push(`- **詳細**: ${post.link}`);
        return lines.join("\n");
      });

      return textResponse(`## 直近の試合結果\n\n${results.join("\n\n")}`);
    } catch (e) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", message: "get_recent_matches failed", context: { error: e instanceof Error ? e.message : String(e) } }));
      return errorResponse("試合結果の取得に失敗しました。しばらく経ってから再度お試しください。");
    }
  },
);

// ─── get_season_results ─────────────────────────────────────
server.tool(
  "get_season_results",
  "指定シーズンの成績サマリーを取得する。全試合の勝敗とシーズン総括を返す。",
  {
    season: z.string().regex(/^\d{4}$/).describe("シーズン年（例: 2025, 2026）"),
  },
  async ({ season }) => {
    try {
      const categoryIds = await getCategoryIdsBySeason(season);

      if (categoryIds.length === 0) {
        const available = await getAvailableSeasons();
        return textResponse(
          `${season}シーズンの試合カテゴリが見つかりませんでした。\n\n利用可能なシーズン: ${available.join(", ")}`,
        );
      }

      // 女子サッカーの年間試合数は通常20-30試合程度。100件で十分カバーできる想定
      const posts = await getPosts({ categories: categoryIds, perPage: 100, order: "asc" });

      if (posts.length === 0) {
        return textResponse(`${season}シーズンの試合データが見つかりませんでした。`);
      }

      const stats = aggregateSeasonResults(posts);
      const totalMatches = stats.wins + stats.draws + stats.losses;
      const points = stats.wins * POINTS_PER_WIN + stats.draws;
      const goalDiff = stats.goalsFor - stats.goalsAgainst;

      return textResponse(
        [
          `## ${season}シーズン成績`,
          ``,
          `| 項目 | 値 |`,
          `|---|---|`,
          `| 試合数 | ${totalMatches} |`,
          `| 勝敗 | ${stats.wins}勝${stats.draws}分${stats.losses}敗 |`,
          `| 勝点 | ${points} |`,
          `| 得点 | ${stats.goalsFor} |`,
          `| 失点 | ${stats.goalsAgainst} |`,
          `| 得失点差 | ${goalDiff >= 0 ? "+" : ""}${goalDiff} |`,
          ``,
          `### 試合一覧`,
          `| 日付 | 結果 | 得点者 |`,
          `|---|---|---|`,
          ...stats.matchSummaries.map((s) => `| ${s} |`),
        ].join("\n"),
      );
    } catch (e) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", message: "get_season_results failed", context: { season, error: e instanceof Error ? e.message : String(e) } }));
      return errorResponse("シーズン成績の取得に失敗しました。しばらく経ってから再度お試しください。");
    }
  },
);

// ─── get_player_blog ────────────────────────────────────────
server.tool(
  "get_player_blog",
  "選手のブログ記事を取得する。選手名で検索して最新記事を返す。",
  {
    player_name: z.string().max(50).describe("選手名（例: 小山莉奈、平良文果）"),
    count: z.number().min(1).max(10).default(3).describe("取得する記事数"),
  },
  async ({ player_name, count }) => {
    try {
      const tags = await getTags();
      const removeWhitespace = (s: string) => s.replace(/[\s　]/g, "");
      const normalizedInput = removeWhitespace(player_name);

      // 完全一致を優先し、見つからなければ部分一致にフォールバック
      const exactMatch = tags.find((t) => removeWhitespace(t.name).replace("ブログ", "") === normalizedInput);
      const partialMatch = tags.find((t) => removeWhitespace(t.name).includes(normalizedInput));
      const playerTag = exactMatch ?? partialMatch;

      if (!playerTag) {
        const playerNames = tags
          .filter((t) => t.name.includes("ブログ"))
          .map((t) => t.name.replace("ブログ", ""))
          .join(", ");
        return textResponse(
          `${sanitizeInput(player_name)}の選手タグが見つかりませんでした。\n\n登録選手: ${playerNames}`,
        );
      }

      const posts = await getPosts({ tags: [playerTag.id], perPage: count, order: "desc" });

      if (posts.length === 0) {
        return textResponse(`${sanitizeInput(player_name)}のブログ記事が見つかりませんでした。`);
      }

      const articles = posts.map((post) => {
        const title = stripHtml(post.title.rendered);
        const body = htmlToMarkdown(post.content.rendered);
        const truncated =
          body.length > BLOG_EXCERPT_MAX_CHARS
            ? body.slice(0, BLOG_EXCERPT_MAX_CHARS) + "\n\n...(続きは記事ページで)"
            : body;
        return [`### ${title}`, `*${post.date.split("T")[0]}*`, ``, truncated, ``, `[記事を読む](${post.link})`].join(
          "\n",
        );
      });

      return textResponse(`## ${playerTag.name}（${playerTag.count}記事）\n\n${articles.join("\n\n---\n\n")}`);
    } catch (e) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", message: "get_player_blog failed", context: { player_name, error: e instanceof Error ? e.message : String(e) } }));
      return errorResponse("ブログ記事の取得に失敗しました。しばらく経ってから再度お試しください。");
    }
  },
);

// ─── get_players ────────────────────────────────────────────
server.tool("get_players", "ブログ記事がある選手の一覧を取得する。記事数も含む。", {}, async () => {
  try {
    const tags = await getTags();
    const players = tags
      .filter((t) => t.name.includes("ブログ"))
      .sort((a, b) => b.count - a.count)
      .map((t) => `- **${t.name.replace("ブログ", "")}** (${t.count}記事)`);

    return textResponse(`## ${HOME_TEAM_NAME} 選手一覧\n\n${players.join("\n")}`);
  } catch (e) {
    console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", message: "get_players failed", context: { error: e instanceof Error ? e.message : String(e) } }));
    return errorResponse("選手一覧の取得に失敗しました。しばらく経ってから再度お試しください。");
  }
});

// ─── get_latest_news ────────────────────────────────────────
server.tool(
  "get_latest_news",
  "最新のクラブニュースを取得する。",
  {
    count: z.number().min(1).max(20).default(5).describe("取得する記事数"),
  },
  async ({ count }) => {
    try {
      const posts = await getPosts({ perPage: count, order: "desc" });
      const articles = posts.map((post) => formatArticleSummary(post, NEWS_EXCERPT_MAX_CHARS));
      return textResponse(`## 最新ニュース\n\n${articles.join("\n\n---\n\n")}`);
    } catch (e) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", message: "get_latest_news failed", context: { error: e instanceof Error ? e.message : String(e) } }));
      return errorResponse("ニュースの取得に失敗しました。しばらく経ってから再度お試しください。");
    }
  },
);

// ─── search_articles ────────────────────────────────────────
server.tool(
  "search_articles",
  "記事をフリーワード検索する。キーワードに一致する記事を返す。",
  {
    query: z.string().max(200).describe("検索キーワード"),
    count: z.number().min(1).max(20).default(5).describe("取得する記事数"),
  },
  async ({ query, count }) => {
    try {
      const posts = await getPosts({ search: query, perPage: count, order: "desc" });

      if (posts.length === 0) {
        return textResponse(`${sanitizeInput(query)}に一致する記事が見つかりませんでした。`);
      }

      const articles = posts.map((post) => formatArticleSummary(post, NEWS_EXCERPT_MAX_CHARS));
      return textResponse(`## ${sanitizeInput(query)}の検索結果（${posts.length}件）\n\n${articles.join("\n\n---\n\n")}`);
    } catch (e) {
      console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", message: "search_articles failed", context: { query, error: e instanceof Error ? e.message : String(e) } }));
      return errorResponse("記事の検索に失敗しました。しばらく経ってから再度お試しください。");
    }
  },
);

// ─── サーバー起動 ───────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "INFO", message: "MCP server started", context: { version: "1.0.0", transport: "stdio" } }));
}

main().catch((error) => {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), level: "ERROR", message: "Server startup failed", context: { error: error instanceof Error ? error.message : String(error) } }));
  process.exit(1);
});
