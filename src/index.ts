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
import { parseMatchInfo, htmlToMarkdown, stripHtml } from "./parser.js";

const server = new McpServer({
  name: "anclas-mcp-server",
  version: "1.0.0",
});

/** MCP textレスポンスのヘルパー */
function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/** Markdownインジェクション防止: ユーザー入力をバッククォートで囲む */
function sanitizeInput(input: string): string {
  return `\`${input.replace(/`/g, "")}\``;
}

const UPCOMING_MATCH_KEYWORDS = ["開幕", "試合情報", "マッチデー", "Kick off", "キックオフ"];
const BLOG_EXCERPT_MAX_CHARS = 1000;
const NEWS_EXCERPT_MAX_CHARS = 200;

// ─── get_next_match ─────────────────────────────────────────
server.tool(
  "get_next_match",
  "次の試合情報を取得する。日時・対戦相手・会場・キックオフ時間を返す。",
  {},
  async () => {
    const posts = await getPosts({ perPage: 30, order: "desc" });

    for (const post of posts) {
      const title = stripHtml(post.title.rendered);
      const content = stripHtml(post.content.rendered);
      const combined = title + " " + content;

      const isAnnouncement = UPCOMING_MATCH_KEYWORDS.some((kw) => combined.includes(kw));
      const hasScore = /(?:福岡J・アンクラス|アンクラス)\s*\d+\s*[(\-–]/.test(content);

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
          `- **スコア**: ${info.score ?? "不明"}`,
          `- **詳細**: ${post.link}`,
        ].join("\n"),
      );
    }

    return textResponse("試合情報が見つかりませんでした。");
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
      if (info.score) lines.push(`- **スコア**: ${info.score}${info.halfTimeScore ? ` (${info.halfTimeScore})` : ""}`);
      if (info.scorers.length > 0) lines.push(`- **得点者**: ${info.scorers.join(", ")}`);
      if (info.venue) lines.push(`- **会場**: ${info.venue}`);
      lines.push(`- **詳細**: ${post.link}`);
      return lines.join("\n");
    });

    return textResponse(`## 直近の試合結果\n\n${results.join("\n\n")}`);
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
    const categoryIds = await getCategoryIdsBySeason(season);

    if (categoryIds.length === 0) {
      const available = await getAvailableSeasons();
      return textResponse(
        `${season}シーズンの試合カテゴリが見つかりませんでした。\n\n利用可能なシーズン: ${available.join(", ")}`,
      );
    }

    const posts = await getPosts({ categories: categoryIds, perPage: 50, order: "asc" });

    if (posts.length === 0) {
      return textResponse(`${season}シーズンの試合データが見つかりませんでした。`);
    }

    let wins = 0,
      draws = 0,
      losses = 0;
    let goalsFor = 0,
      goalsAgainst = 0;
    const matchSummaries: string[] = [];

    for (const post of posts) {
      const title = stripHtml(post.title.rendered);
      const info = parseMatchInfo(title, post.content.rendered);

      if (info.score) {
        const [home, away] = info.score.split("-").map(Number);
        if (!isNaN(home) && !isNaN(away)) {
          goalsFor += home;
          goalsAgainst += away;
          if (home > away) wins++;
          else if (home === away) draws++;
          else losses++;
        }
        matchSummaries.push(
          `${info.date ?? "?"} | ${info.homeTeam} ${info.score} ${info.awayTeam ?? "?"} | ${info.scorers.length > 0 ? info.scorers.join(", ") : "-"}`,
        );
      }
    }

    const totalMatches = wins + draws + losses;
    const POINTS_PER_WIN = 3;
    const points = wins * POINTS_PER_WIN + draws;
    const goalDiff = goalsFor - goalsAgainst;

    return textResponse(
      [
        `## ${season}シーズン成績`,
        ``,
        `| 項目 | 値 |`,
        `|---|---|`,
        `| 試合数 | ${totalMatches} |`,
        `| 勝敗 | ${wins}勝${draws}分${losses}敗 |`,
        `| 勝点 | ${points} |`,
        `| 得点 | ${goalsFor} |`,
        `| 失点 | ${goalsAgainst} |`,
        `| 得失点差 | ${goalDiff >= 0 ? "+" : ""}${goalDiff} |`,
        ``,
        `### 試合一覧`,
        `| 日付 | 結果 | 得点者 |`,
        `|---|---|---|`,
        ...matchSummaries.map((s) => `| ${s} |`),
      ].join("\n"),
    );
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
    const tags = await getTags();
    const normalize = (s: string) => s.replace(/[\s　]/g, "");
    const normalizedInput = normalize(player_name);
    const playerTag = tags.find((t) => normalize(t.name).includes(normalizedInput));

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
  },
);

// ─── get_players ────────────────────────────────────────────
server.tool("get_players", "選手一覧を取得する。ブログ記事数も含む。", {}, async () => {
  const tags = await getTags();
  const players = tags
    .filter((t) => t.name.includes("ブログ"))
    .sort((a, b) => b.count - a.count)
    .map((t) => `- **${t.name.replace("ブログ", "")}** (${t.count}記事)`);

  return textResponse(`## 福岡J・アンクラス 選手一覧\n\n${players.join("\n")}`);
});

// ─── get_latest_news ────────────────────────────────────────
server.tool(
  "get_latest_news",
  "最新のクラブニュースを取得する。",
  {
    count: z.number().min(1).max(20).default(5).describe("取得する記事数"),
  },
  async ({ count }) => {
    const posts = await getPosts({ perPage: count, order: "desc" });

    const articles = posts.map((post) => {
      const title = stripHtml(post.title.rendered);
      const excerpt = stripHtml(post.excerpt.rendered).slice(0, NEWS_EXCERPT_MAX_CHARS);
      return `### ${title}\n*${post.date.split("T")[0]}* | ${post.link}\n\n${excerpt}`;
    });

    return textResponse(`## 最新ニュース\n\n${articles.join("\n\n---\n\n")}`);
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
    const posts = await getPosts({ search: query, perPage: count, order: "desc" });

    if (posts.length === 0) {
      return textResponse(`${sanitizeInput(query)}に一致する記事が見つかりませんでした。`);
    }

    const articles = posts.map((post) => {
      const title = stripHtml(post.title.rendered);
      const excerpt = stripHtml(post.excerpt.rendered).slice(0, NEWS_EXCERPT_MAX_CHARS);
      return `### ${title}\n*${post.date.split("T")[0]}* | ${post.link}\n\n${excerpt}`;
    });

    return textResponse(`## ${sanitizeInput(query)}の検索結果（${posts.length}件）\n\n${articles.join("\n\n---\n\n")}`);
  },
);

// ─── サーバー起動 ───────────────────────────────────────────
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
