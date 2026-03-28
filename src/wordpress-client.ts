const BASE_URL = "https://anclas.jp/wp-json/wp/v2";

export interface WPPost {
  id: number;
  date: string;
  title: { rendered: string };
  content: { rendered: string };
  excerpt: { rendered: string };
  link: string;
  categories: number[];
  tags: number[];
  featured_media: number;
}

export interface WPCategory {
  id: number;
  name: string;
  slug: string;
  count: number;
}

export interface WPTag {
  id: number;
  name: string;
  slug: string;
  count: number;
}

const ALLOWED_PATHS = ["/posts", "/categories", "/tags"] as const;

async function wpFetch<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  if (!ALLOWED_PATHS.some((p) => path === p)) {
    throw new Error(`Invalid API path: ${path}`);
  }
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WordPress API error: ${res.status} ${res.statusText} - ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function getPosts(params: {
  categories?: number[];
  tags?: number[];
  search?: string;
  perPage?: number;
  page?: number;
  orderby?: string;
  order?: "asc" | "desc";
} = {}): Promise<WPPost[]> {
  const query: Record<string, string> = {
    per_page: String(params.perPage ?? 10),
    page: String(params.page ?? 1),
    orderby: params.orderby ?? "date",
    order: params.order ?? "desc",
  };
  if (params.categories?.length) query.categories = params.categories.join(",");
  if (params.tags?.length) query.tags = params.tags.join(",");
  if (params.search) query.search = params.search;
  return wpFetch<WPPost[]>("/posts", query);
}

export async function getCategories(): Promise<WPCategory[]> {
  return wpFetch<WPCategory[]>("/categories", { per_page: "100" });
}

export async function getTags(): Promise<WPTag[]> {
  return wpFetch<WPTag[]>("/tags", { per_page: "100" });
}

// 試合カテゴリを動的に取得（起動時にキャッシュ）
let gameCategoriesCache: WPCategory[] | null = null;

export async function getGameCategories(): Promise<WPCategory[]> {
  if (gameCategoriesCache) return gameCategoriesCache;
  const all = await getCategories();
  gameCategoriesCache = all.filter((c) => /^GAME/i.test(c.name));
  return gameCategoriesCache;
}

export async function getAllGameCategoryIds(): Promise<number[]> {
  const cats = await getGameCategories();
  return cats.map((c) => c.id);
}

/** カテゴリ名から大会名を抽出: "GAME (Qリーグ) 2025" → "Qリーグ" */
function extractCompetitionFromCategory(name: string): string | null {
  const match = name.match(/GAME\s*[（(](.+?)[)）]/i);
  return match ? match[1] : null;
}

/** カテゴリ名から年を抽出: "GAME (Qリーグ) 2025" → "2025" */
function extractYearFromCategory(name: string): string | null {
  const match = name.match(/(\d{4})/);
  return match ? match[1] : null;
}

/** 指定大会に一致するカテゴリIDを取得 */
export async function getCategoryIdsByCompetition(competition: string): Promise<number[]> {
  const cats = await getGameCategories();
  return cats
    .filter((c) => extractCompetitionFromCategory(c.name) === competition)
    .map((c) => c.id);
}

/** 指定シーズン年に一致するカテゴリIDを取得 */
export async function getCategoryIdsBySeason(year: string): Promise<number[]> {
  const cats = await getGameCategories();
  return cats
    .filter((c) => extractYearFromCategory(c.name) === year)
    .map((c) => c.id);
}

/** 利用可能なシーズン年の一覧を取得 */
export async function getAvailableSeasons(): Promise<string[]> {
  const cats = await getGameCategories();
  const years = new Set<string>();
  for (const c of cats) {
    const year = extractYearFromCategory(c.name);
    if (year) years.add(year);
  }
  return [...years].sort().reverse();
}
