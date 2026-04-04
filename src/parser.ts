export const HOME_TEAM_NAME = "福岡J・アンクラス";
const HOME_TEAM_PATTERN = /(?:福岡J・アンクラス|アンクラス)/;

export interface MatchScore {
  anclasGoals: number;
  opponentGoals: number;
}

export interface MatchInfo {
  date: string | null;
  kickoff: string | null;
  venue: string | null;
  homeTeam: string;
  awayTeam: string | null;
  score: MatchScore | null;
  /** 表示用スコア文字列（例: "4-1"） */
  scoreDisplay: string | null;
  halfTimeScore: string | null;
  scorers: string[];
  competition: string | null;
}

/** HTMLタグを除去してプレーンテキストにする */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/?(div|li|tr|h[1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8211;/g, "–")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 投稿本文からスコア情報を抽出 */
function parseScore(text: string): { score: MatchScore | null; scoreDisplay: string | null; halfTimeScore: string | null; awayTeam: string | null } {
  // パターン: "福岡J・アンクラス 4(1-0,3-1)1 琉球デイゴス"
  const detailedPattern = new RegExp(
    HOME_TEAM_PATTERN.source + String.raw`\s*(?<anclasGoals>\d+)\s*\((?<halfTime>[^)]+)\)\s*(?<opponentGoals>\d+)\s*(?<opponent>.+?)(?:\n|$)`,
  );
  const detailedMatch = text.match(detailedPattern);
  if (detailedMatch?.groups) {
    const anclasGoals = Number(detailedMatch.groups.anclasGoals);
    const opponentGoals = Number(detailedMatch.groups.opponentGoals);
    return {
      score: { anclasGoals, opponentGoals },
      scoreDisplay: `${anclasGoals}-${opponentGoals}`,
      halfTimeScore: detailedMatch.groups.halfTime,
      awayTeam: detailedMatch.groups.opponent.trim(),
    };
  }

  // パターン: "福岡J・アンクラス 4 - 1 琉球デイゴス"
  const simplePattern = new RegExp(
    HOME_TEAM_PATTERN.source + String.raw`\s*(?<anclasGoals>\d+)\s*[-–]\s*(?<opponentGoals>\d+)\s*(?<opponent>.+?)(?:\n|$)`,
  );
  const simpleMatch = text.match(simplePattern);
  if (simpleMatch?.groups) {
    const anclasGoals = Number(simpleMatch.groups.anclasGoals);
    const opponentGoals = Number(simpleMatch.groups.opponentGoals);
    return {
      score: { anclasGoals, opponentGoals },
      scoreDisplay: `${anclasGoals}-${opponentGoals}`,
      halfTimeScore: null,
      awayTeam: simpleMatch.groups.opponent.trim(),
    };
  }

  return { score: null, scoreDisplay: null, halfTimeScore: null, awayTeam: null };
}

/** 得点者を抽出 */
function parseScorers(text: string): string[] {
  const pattern = /得点者[：:]\s*(.+?)(?:\n|$)/g;
  const scorers: string[] = [];
  let scorerMatch;
  while ((scorerMatch = pattern.exec(text)) !== null) {
    scorers.push(...scorerMatch[1].split(/[、,]/).map(s => s.trim()).filter(Boolean));
  }
  return scorers;
}

/** 試合日時を抽出 */
function parseDateTime(text: string): { date: string | null; kickoff: string | null } {
  // "2026 年 4 月 12 日 (日)、12：00キックオフ" (全角コロン・スペース入り)
  const wideFormatPattern = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[（(][日月火水木金土][)）][、,]?\s*(\d{1,2})[：:](\d{2})/;
  const wideFormatMatch = text.match(wideFormatPattern);
  if (wideFormatMatch) {
    return {
      date: `${wideFormatMatch[1]}年${wideFormatMatch[2]}月${wideFormatMatch[3]}日`,
      kickoff: `${wideFormatMatch[4]}:${wideFormatMatch[5]}`,
    };
  }

  // "4月12日（日）12:00" or "11月30日（日）11:00 Kick off"
  const shortFormatPattern = /(\d{1,2})月(\d{1,2})日[（(][日月火水木金土][)）][、,]?\s*(\d{1,2})[：:](\d{2})/;
  const shortFormatMatch = text.match(shortFormatPattern);
  if (shortFormatMatch) {
    return {
      date: `${shortFormatMatch[1]}月${shortFormatMatch[2]}日`,
      kickoff: `${shortFormatMatch[3]}:${shortFormatMatch[4]}`,
    };
  }

  // "2026年4月12日" (時刻なし)
  const dateOnlyPattern = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
  const dateOnlyMatch = text.match(dateOnlyPattern);
  if (dateOnlyMatch) {
    return {
      date: `${dateOnlyMatch[1]}年${dateOnlyMatch[2]}月${dateOnlyMatch[3]}日`,
      kickoff: null,
    };
  }

  return { date: null, kickoff: null };
}

/** 会場を抽出 */
function parseVenue(text: string): string | null {
  const patterns = [
    /試合会場\s*\n\s*(.+?)(?:[（(]|住所|\n)/,  // ラベル構造: "試合会場\nXXX（住所）"
    /(?:^|\n)@\s*(.+?)(?:\n|$)/,
    /会場[：:]\s*(.+?)(?:\n|$)/,
    /Kick\s*off\s*[@＠]\s*(.+?)(?:\n|$)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].trim();
  }
  return null;
}

/** 対戦相手を抽出（告知ページのラベル構造用） */
function parseOpponent(text: string): string | null {
  // "対戦相手\nXXX（地域名）"
  const pattern = /対戦相手\s*\n\s*(.+?)(?:[（(]|\n|$)/;
  const match = text.match(pattern);
  if (match) return match[1].trim();
  // "vs.XXX" or "vs XXX"
  const vsPattern = /vs[.．]?\s*(.+?)(?:[（(\n]|$)/i;
  const match2 = text.match(vsPattern);
  if (match2) return match2[1].trim();
  return null;
}

/** 大会名を抽出 */
function parseCompetition(title: string): string | null {
  if (/九州女子サッカーリーグ|Qリーグ/i.test(title)) return "Qリーグ";
  if (/なでしこリーグ/i.test(title)) return "なでしこリーグ";
  if (/皇后杯/i.test(title)) return "皇后杯";
  return null;
}

/** 投稿のタイトルと本文HTMLから試合情報を抽出する */
export function parseMatchInfo(title: string, contentHtml: string): MatchInfo {
  const text = stripHtml(contentHtml);
  const { date, kickoff } = parseDateTime(text);
  const venue = parseVenue(text);
  const { score, scoreDisplay, halfTimeScore, awayTeam } = parseScore(text);
  const scorers = parseScorers(text);
  const competition = parseCompetition(title);
  // スコアから対戦相手が取れなければラベル構造/vsパターンで補完
  const resolvedAwayTeam = awayTeam ?? parseOpponent(text);

  return {
    date,
    kickoff,
    venue,
    homeTeam: HOME_TEAM_NAME,
    awayTeam: resolvedAwayTeam,
    score,
    scoreDisplay,
    halfTimeScore,
    scorers,
    competition,
  };
}

/** HTMLをMarkdown風テキストに変換（記事表示用） */
export function htmlToMarkdown(html: string): string {
  let md = html;
  // 見出し
  md = md.replace(/<h([1-6])[^>]*>(.*?)<\/h[1-6]>/gi, (_, level, content) => {
    return "\n" + "#".repeat(Number(level)) + " " + stripHtml(content) + "\n";
  });
  // リスト
  md = md.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1");
  // 強調
  md = md.replace(/<(strong|b)[^>]*>(.*?)<\/(strong|b)>/gi, "**$2**");
  md = md.replace(/<(em|i)[^>]*>(.*?)<\/(em|i)>/gi, "*$2*");
  // リンク
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, "[$2]($1)");
  // 画像
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*alt="([^"]*)"[^>]*\/?>/gi, "![$2]($1)");
  md = md.replace(/<img[^>]*src="([^"]*)"[^>]*\/?>/gi, "![]($1)");
  // 残りのタグ除去
  return stripHtml(md);
}
