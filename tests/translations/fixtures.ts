import type { Lang } from '../../packages/translator-core/src';

export interface TranslationFixture {
  id: string;
  category: string;
  source: Lang;
  target: Lang;
  text: string;
  expectedLanguage: Lang;
  /** Each group contains alternative spellings; diagnostic only, not a quality score. */
  expectedKeywords: string[][];
}

interface Sentence {
  category: string;
  ja: string;
  en: string;
  ru: string;
  keywords: Record<Lang, string[][]>;
}

// Original evaluation sentences. These parallel examples are review aids,
// not certified reference translations or proof of semantic accuracy.
const sentences: Sentence[] = [
  {
    category: 'short',
    ja: 'おはようございます。今日はいい天気ですね。',
    en: 'Good morning. The weather is nice today.',
    ru: 'Доброе утро. Сегодня хорошая погода.',
    keywords: { ja: [['天気']], en: [['weather']], ru: [['погод']] },
  },
  {
    category: 'casual',
    ja: '明日、一緒に公園へ行きませんか。',
    en: 'Would you like to go to the park together tomorrow?',
    ru: 'Хочешь завтра вместе пойти в парк?',
    keywords: { ja: [['明日'], ['公園']], en: [['tomorrow'], ['park']], ru: [['завтра'], ['парк']] },
  },
  {
    category: 'polite',
    ja: '恐れ入りますが、駅への行き方を教えていただけますか。',
    en: 'Excuse me, could you please tell me how to get to the station?',
    ru: 'Извините, не могли бы вы подсказать, как пройти к станции?',
    keywords: { ja: [['駅']], en: [['station']], ru: [['станц', 'вокзал']] },
  },
  {
    category: 'negation',
    ja: '私は肉を食べませんが、魚は食べます。',
    en: 'I do not eat meat, but I eat fish.',
    ru: 'Я не ем мясо, но ем рыбу.',
    keywords: { ja: [['肉'], ['魚']], en: [['not', "don't"], ['meat'], ['fish']], ru: [['не'], ['мяс'], ['рыб']] },
  },
  {
    category: 'quantity',
    ja: 'りんごを3個と、水を2本ください。',
    en: 'I would like three apples and two bottles of water, please.',
    ru: 'Дайте, пожалуйста, три яблока и две бутылки воды.',
    keywords: { ja: [['りんご', 'リンゴ', '林檎'], ['水']], en: [['three', '3'], ['two', '2']], ru: [['три', '3'], ['две', '2']] },
  },
  {
    category: 'date',
    ja: '会議は11月20日の午前10時に始まります。',
    en: 'The meeting starts at ten in the morning on November twentieth.',
    ru: 'Встреча начнётся двадцатого ноября в десять часов утра.',
    keywords: { ja: [['会議', '会合', 'ミーティング']], en: [['meeting'], ['november']], ru: [['встреч', 'совещан', 'собрани'], ['ноябр']] },
  },
  {
    category: 'proper-noun',
    ja: 'アンナは東京で日本語を勉強しています。',
    en: 'Anna is studying Japanese in Tokyo.',
    ru: 'Анна изучает японский язык в Токио.',
    keywords: { ja: [['東京'], ['日本語']], en: [['tokyo'], ['japanese']], ru: [['токио'], ['японск']] },
  },
  {
    category: 'technical',
    ja: 'このアプリはインターネットに接続せずに文章を翻訳します。',
    en: 'This application translates text without an internet connection.',
    ru: 'Это приложение переводит текст без подключения к интернету.',
    keywords: { ja: [['翻訳'], ['インターネット']], en: [['translat'], ['internet']], ru: [['перевод'], ['интернет']] },
  },
  {
    category: 'paragraphs',
    ja: '明日は雨が降る予定なので、傘を持っていきます。\n駅で友達に会ってから、一緒に美術館へ行くつもりです。',
    en: 'It is going to rain tomorrow, so I will bring an umbrella.\nAfter meeting my friend at the station, we plan to visit the museum together.',
    ru: 'Завтра ожидается дождь, поэтому я возьму зонт.\nПосле встречи с другом на станции мы собираемся вместе посетить музей.',
    keywords: { ja: [['傘'], ['美術館', '博物館']], en: [['umbrella'], ['museum']], ru: [['зонт'], ['музей', 'музея', 'музею']] },
  },
  {
    category: 'ambiguity',
    ja: '彼女はその本をまだ読んでいないと言いました。',
    en: 'She said that she had not read the book yet.',
    ru: 'Она сказала, что ещё не читала эту книгу.',
    keywords: { ja: [['本'], ['読']], en: [['not', "hadn't"], ['book']], ru: [['не'], ['книг']] },
  },
];

export const LANGUAGE_DIRECTIONS: readonly [Lang, Lang][] = [
  ['ja', 'en'], ['ru', 'en'], ['en', 'ja'], ['en', 'ru'], ['ja', 'ru'], ['ru', 'ja'],
];

export const TRANSLATION_FIXTURES: TranslationFixture[] = LANGUAGE_DIRECTIONS.flatMap(([source, target]) =>
  sentences.map((sentence, index) => ({
    id: `${source}-${target}-${String(index + 1).padStart(2, '0')}`,
    category: sentence.category,
    source,
    target,
    text: sentence[source],
    expectedLanguage: target,
    expectedKeywords: sentence.keywords[target],
  })),
);

export function hasExpectedScript(text: string, language: Lang): boolean {
  if (language === 'ja') return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
  if (language === 'ru') return /\p{Script=Cyrillic}/u.test(text);
  return /\p{Script=Latin}/u.test(text)
    && !/[\p{Script=Cyrillic}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text);
}
