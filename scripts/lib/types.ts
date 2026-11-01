/**
 * 数据契约 —— 各构建脚本产出/消费的 JSON 结构。
 *
 * 这些结构在脚本之间来回传（曲库 → 索引 → 目录 → 打包），字段名写错不会报错，
 * 只会静默产出错数据。所以把契约集中在这里。
 *
 * ⚠️ 字段以**实际产物**为准，不是设计稿。改脚本产出时同步改这里。
 */

// ---------------------------------------------------------------------------
// 公共
// ---------------------------------------------------------------------------

export type Difficulty = 'PST' | 'PRS' | 'FTR' | 'BYD' | 'ETR' | 'INS';

/** 定数来源。优先级：数字越小越可信，见 build-catalog 的 CONSTANT_PRIORITY */
export type ConstantSource = 'wiki' | 'songdb' | 'video' | 'derived';

/** song_id 的可信度：official = 来自官方数据；derived = 由曲名推导，需核对 */
export type SongIdSource = 'official' | 'derived';

// ---------------------------------------------------------------------------
// 视频来源（索引层产出 → 目录层透传）
// ---------------------------------------------------------------------------

export interface VideoSource {
  bvid: string;
  /** 分P页码，从 1 开始，与 URL 的 ?p=N 一致 */
  p: number;
  url: string;
  duration_sec: number;
  /** 分P标题才是权威的；同一 BV 的视频标题可能与它不一致 */
  part_title: string;
  /** ⚠️ 目录层已**拍平成名字数组**；索引层是对象数组，见 CollectionRef */
  collections: string[];
  /**
   * 显示尺寸（rotate 为 90/270 时已交换宽高）。
   * 渲染层据此选 16:9 / 4:3 模板 —— 实测 37.5% 的来源是 4:3。
   * 缺省表示上游没给，调用方要按"未知"处理。
   */
  video_width?: number;
  video_height?: number;
  /**
   * 上传者（UP主）。**署名用的，不是装饰**（铁律 8）。
   *
   * 数据来自 `x/web-interface/view` 响应的 `data.owner` —— 那个接口本来就要调
   * （为了拿 pages[]），所以这一项是**零额外请求**的。
   * 缺省表示上游没给或旧产物：调用方要按"未知"处理，**不要伪造**。
   */
  owner_name?: string;
  owner_mid?: number;
  /** 视频标题里的难度与分P标题不一致时的另一组取值，交人工裁决 */
  alt_difficulty?: { difficulty: string; level: string | null; constant: number | null };
}

/** 索引层里 collections 的原样：`{ name, kind }`，目录层才 map 成 string[] */
export interface CollectionRef {
  name: string;
  kind: string;
}

/** 索引层的来源还多带原始视频信息（合并进目录时会被精简掉） */
export interface IndexVideoSource extends Omit<VideoSource, 'collections'> {
  collections: CollectionRef[];
  video_title: string;
  video_pages: number;
}

// ---------------------------------------------------------------------------
// 索引层（build-arcaea-index → data/arcaea-index.json）
// ---------------------------------------------------------------------------

/**
 * ⚠️ 索引层的定数来源与目录层**不是同一套枚举**。
 *
 * 目录层是 `wiki | songdb | video | derived`（合并后的优先级口径），
 * 索引层只区分这条数据是**从视频标题读到的**还是**从曲库回填的**。
 * 两者混用会导致 `build-catalog.ts` 的优先级比较出错。
 */
export type IndexConstantSource = 'video_title' | 'song_db';

export interface IndexChart {
  /** (曲名, 难度, 定数) 拼出来的稳定键 */
  chart_key: string;
  title: string;
  title_norm: string;
  difficulty: Difficulty;
  level: string | null;
  constant: number | null;
  constant_source: IndexConstantSource | null;
  /** 同一谱面多个来源给出不同定数时的全部取值，**只有冲突时才写入** */
  constant_conflict?: number[];
  /** ⚠️ 只有命中曲库时才写入 —— 实测 650 条里有 295 条没有 */
  song_id?: string | null;
  song_match_via?: string | null;
  sources: IndexVideoSource[];
}

/** 索引层的解析失败记录 */
export interface UnparsedEntry {
  bvid: string;
  p: number | null;
  part_title: string;
  video_title: string;
  /** ⚠️ 抓取/分P阶段就失败的条目拿不到集合信息，所以是可选的 */
  collection?: string | null;
  reason: string;
  extracted_title?: string | null;
  extras?: unknown;
  error?: string;
}

export interface IndexFile {
  schema_version: number;
  game: string;
  generated_at: string;
  generator: string;
  source: {
    platform: string;
    mid: string;
    manual_sources_file?: string | null;
    collections: Array<{ kind: 'season' | 'series'; id: string; name: string; videos: number }>;
  };
  stats: Record<string, unknown>;
  charts: IndexChart[];
  unparsed: UnparsedEntry[];
}

// ---------------------------------------------------------------------------
// 目录层（build-catalog → data/arcaea-catalog.json）—— 应用唯一读取的文件
// ---------------------------------------------------------------------------

export interface CatalogChart {
  difficulty: Difficulty;
  level: string;
  constant: number | null;
  constant_source?: ConstantSource;
  /** 多来源给出不同定数时的全部候选值，不丢弃 */
  constant_candidates?: Partial<Record<ConstantSource, number>>;
  /** 物量。OCR 判定数守恒校验要用 */
  note: number | null;
  chart_designer?: string;
  jacket_designer?: string;
  video: { sources: VideoSource[] } | null;
  /** 该难度有独立曲名时才有，如 Last 的 BYD 叫 "Last | Moment" */
  alt_title?: string;
  /**
   * 该难度专属曲绘（Beyond 谱面经常有自己的图）。没有就是显式 null。
   * ⚠️ 应用侧的解析规则是 `chart.jacket ?? song.jacket` —— 不要自己拼文件名，
   *    命名有两种写法（`<id>_<难度>` 与别名词），构建期已经解析好了。
   * 实测 47 个难度有专属曲绘。
   */
  jacket: CatalogJacket | null;
  /**
   * 该难度专属曲绘的指纹，没有专属曲绘就是 null。
   * 为什么要它：图上用了 BYD 专属封面时，拿默认封面的指纹去比会对不上（实测差 29 位），
   * 只有比过两种封面才能定住曲目。
   */
  phash?: { ahash: string; dhash?: string } | null;
}

export interface CatalogJacket {
  bundled: boolean;
  /** ⚠️ 无曲绘时写的是**显式 null**（不是省略），实测 26 首如此 */
  local_256?: string | null;
  full_url?: string | null;
  thumb_url_256?: string | null;
  native?: string | null;
  source?: string | null;
  source_hint?: string | null;
}

export interface CatalogSong {
  song_id: string;
  song_id_source: SongIdSource;
  title_en: string;
  title_jp: string;
  title_norm: string;
  aliases: string[];
  /** OCR 纠错用：曲名/日文名/song_id/别名的归一化集合，应用侧一次 Map 查找 */
  match_keys: string[];
  artist: string;
  bpm: number | null;
  set: string;
  set_friendly: string;
  version: string;
  date: number | null;
  time_sec: number | null;
  /**
   * ⚠️ 不可信 —— 198 首 derived 曲目里它 100% 等于 song_id，是构建时的占位值。
   * 权威来源是 data/arcaea-backgrounds.json。
   */
  bg: string;
  jacket: CatalogJacket;
  /**
   * 感知哈希。⚠️ `dhash` 可能缺席 —— build-jackets 允许
   * 「aHash 成功但 dHash 抛错」的截断图场景只写 ahash。
   */
  phash: { ahash: string; dhash?: string } | null;
  charts: CatalogChart[];
}

export interface CatalogFile {
  schema_version: number;
  game: string;
  generated_at: string;
  generator: string;
  difficulty_class_order: Difficulty[];
  constant_priority: Record<ConstantSource, number>;
  notes: string[];
  provenance: Record<string, unknown>;
  stats: Record<string, number | boolean>;
  songs: CatalogSong[];
  unresolved: Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// 背景层（build-backgrounds → data/arcaea-backgrounds.json）
// ---------------------------------------------------------------------------

export interface BackgroundEntry {
  name: string;
  file: string;
  source_page: string;
  original: string;
  /** 原图尺寸，如 "1920x1440" */
  native: string;
  /** 实际下载的源图宽度（标准档位之一） */
  source_width: number;
  /**
   * 输出宽度 → 文件信息（路径一律正斜杠）。
   * ⚠️ ffmpeg 处理失败时该档位**只写 error**，所以 path/bytes 必须可选。
   */
  files: Record<string, { path?: string; bytes?: number; error?: string }>;
  songs: string[];
}

export interface BackgroundManifest {
  schema_version: number;
  game: string;
  generated_at: string;
  generator: string;
  sources: { mapping: string; images: string };
  notes: string[];
  output_aspect: string;
  backgrounds: Record<string, BackgroundEntry>;
  songs: Record<string, {
    bg: string | null;
    bg_inverse: string | null;
    /** 官方 song_id —— catalog 里有 198 首的 id 是推导的，这是两者的桥 */
    official_id: string;
    matched_via: 'id' | 'title' | 'loose';
  }>;
  unresolved: {
    songs_not_in_songlist: Array<{ song_id: string; title: string }>;
    bg_without_image: Array<{ bg: string; song_id: string }>;
  };
}

// ---------------------------------------------------------------------------
// wiki 的 Songlist.json（build-backgrounds 消费）
// ---------------------------------------------------------------------------

export interface SongListEntry {
  idx: number;
  /** 官方 song_id */
  id: string;
  title_localized?: { en?: string; ja?: string };
  artist?: string;
  search_title?: { ja?: string[]; ko?: string[] };
  bpm?: string;
  bpm_base?: number;
  set?: string;
  /** side 0 = 光芒侧，bg 是 light 系；side 1 = 纷争侧，bg 是 conflict 系 */
  side?: number;
  bg?: string;
  bg_inverse?: string;
  date?: number;
  version?: string;
  difficulties?: Array<{
    ratingClass: number;
    chartDesigner?: string;
    jacketDesigner?: string;
    rating?: number;
    ratingPlus?: boolean;
    jacketOverride?: boolean;
  }>;
}

export interface SongListFile {
  songs: SongListEntry[];
}

// ---------------------------------------------------------------------------
// 曲绘层（build-jackets → data/arcaea-jackets.json）
// ---------------------------------------------------------------------------

/**
 * 曲绘条目。
 *
 * ⚠️ 每个字段都可能因为"那一步失败了"而缺席 —— build-jackets 是**部分成功也写入**的：
 * 下载失败写 `<sizes>_error`，哈希失败写 `hash_error`，所以 ahash/dhash 只是可选，
 * 宽高字节同理。消费方必须按"可能没有"处理，别照抄当前数据的完整字段。
 */
export interface JacketEntry {
  song_id: string;
  file: string;
  width?: number;
  height?: number;
  bytes?: number;
  url?: string;
  thumb_url_256?: string;
  local: { thumb256?: string; full?: string; thumb256_error?: string; full_error?: string };
  ahash?: string;
  dhash?: string;
  hash_error?: string;
}

export interface JacketsFile {
  schema_version: number;
  game: string;
  generated_at: string;
  generator: string;
  source: Record<string, unknown>;
  hash: Record<string, unknown>;
  stats: Record<string, unknown>;
  jackets: JacketEntry[];
}
