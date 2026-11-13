/**
 * Privacy policy and terms **templates** for the Russia copy (`ru.mail.cumuluscloud.app`).
 *
 * These are NOT final documents and must not be presented as such. They are a starting point for a
 * Russian lawyer: the structure 152-ФЗ expects, with every fact the operator has to state left as a
 * `{{FIELD}}` placeholder. A page with any placeholder left in it is served as a visible draft, and
 * `noindex`, so a half-filled policy cannot be mistaken for the published one or end up in search.
 *
 * Filling the fields does not make the text approved. `REVIEWED` has to be set deliberately, by a
 * person who has had the wording checked, for the draft banner to come off.
 */
export type LegalDoc = "privacy" | "terms";

/** What the owner has to supply. Every one of these is a fact only they know. */
export const FIELDS = [
  { key: "OPERATOR_NAME", what: "Full legal name of the operator (оператор персональных данных)" },
  { key: "OPERATOR_FORM", what: "Legal form and registration numbers (ОГРН / ИНН), or the foreign equivalent" },
  { key: "OPERATOR_ADDRESS", what: "Registered legal address" },
  { key: "OPERATOR_EMAIL", what: "Contact address for data subjects' requests" },
  { key: "DPO_CONTACT", what: "Person responsible for processing personal data (ответственный за организацию обработки), and how to reach them" },
  { key: "DATA_LOCATION", what: "Where the database holding Russian citizens' personal data physically is (ст. 18 ч. 5 152-ФЗ)" },
  { key: "RKN_REGISTRATION", what: "Roskomnadzor register entry for the operator, or a statement of why none is required" },
  { key: "RETENTION", what: "How long each category is kept, and what happens on account closure" },
  { key: "CROSS_BORDER", what: "Whether data leaves Russia, to which countries, and on what basis (ст. 12)" },
  { key: "CONSENT_TEXT", what: "The consent wording shown at sign-up (ст. 9): purposes, categories, actions, term, how to withdraw" },
  { key: "REFUND_POLICY", what: "Refund terms for paid plans" },
  { key: "GOVERNING_LAW", what: "Governing law and the court for disputes" },
  { key: "EFFECTIVE_DATE", what: "Date this version takes effect" },
] as const;

export type FieldKey = (typeof FIELDS)[number]["key"];
export type Values = Partial<Record<FieldKey, string>>;

const PLACEHOLDER = /\{\{([A-Z_]+)\}\}/g;

/** Every `{{FIELD}}` still unfilled in the rendered text, in the order they appear, without repeats. */
export function unfilled(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** Replace what the owner supplied; anything they did not stays a visible `{{FIELD}}`. */
export function fill(template: string, values: Values): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => {
    const value = values[key as FieldKey]?.trim();
    return value ? value : whole;
  });
}

export const PRIVACY_RU = `# Политика конфиденциальности Cumulus://Mail

**Редакция от {{EFFECTIVE_DATE}}.**

## 1. Оператор

Оператором персональных данных является {{OPERATOR_NAME}} ({{OPERATOR_FORM}}), адрес: {{OPERATOR_ADDRESS}}.
Вопросы об обработке персональных данных: {{OPERATOR_EMAIL}}.
Ответственный за организацию обработки персональных данных: {{DPO_CONTACT}}.
Сведения о регистрации в реестре операторов: {{RKN_REGISTRATION}}.

## 2. Какие данные обрабатываются

- **Учётная запись.** Идентификатор Cumulus://ID, адрес электронной почты, отображаемое имя.
- **Содержимое почтового ящика.** Письма, вложения, черновики, контакты, календарные записи, правила и
  папки. Содержимое хранится в зашифрованном виде; ключи описаны в разделе 4.
- **Технические данные.** IP-адрес, сведения об устройстве и браузере, время и результат входа.
  IP-адрес используется в том числе для ограничения частоты попыток входа.
- **Платёжные данные.** При оплате тарифа — сведения, необходимые платёжному провайдеру. Полные
  реквизиты карты Оператору не передаются и им не хранятся.

## 3. Цели и основания обработки

| Цель | Основание |
|---|---|
| Предоставление почтового сервиса | Договор (ст. 6 ч. 1 п. 5 152-ФЗ) |
| Защита от спама, злоупотреблений и несанкционированного доступа | Законный интерес Оператора |
| Исполнение требований законодательства | Закон |
| Иные цели, указанные в согласии | Согласие субъекта (ст. 9 152-ФЗ) |

Текст согласия, которое запрашивается при регистрации: {{CONSENT_TEXT}}

Согласие может быть отозвано в любой момент обращением по адресу {{OPERATOR_EMAIL}}. Отзыв согласия не
затрагивает обработку, необходимую для исполнения договора.

## 4. Шифрование

Содержимое почтового ящика хранится в зашифрованном виде. Письма между аккаунтами Cumulus шифруются
сквозным шифрованием. Письма, отправляемые внешним адресатам или получаемые от них, шифруются при
хранении, но покидают защищённый канал при доставке. Содержимое не анализируется для показа рекламы и
не передаётся третьим лицам для маркетинга.

## 5. Место обработки и хранения

База данных, содержащая персональные данные граждан Российской Федерации, находится: {{DATA_LOCATION}}.
Трансграничная передача данных: {{CROSS_BORDER}}.

## 6. Срок хранения

{{RETENTION}}

## 7. Передача третьим лицам

Персональные данные передаются третьим лицам только: поставщикам инфраструктуры, действующим по
поручению Оператора; платёжному провайдеру — в объёме, необходимом для проведения платежа; органам
власти — в случаях и порядке, предусмотренных законом.

## 8. Права субъекта персональных данных

Субъект вправе получать сведения об обработке своих персональных данных, требовать их уточнения,
блокирования или уничтожения, отзывать согласие и обжаловать действия Оператора в Роскомнадзоре или в
суде. Обращения направляются по адресу {{OPERATOR_EMAIL}} и рассматриваются в сроки, установленные
законом.

## 9. Изменения

Новая редакция публикуется на этой странице с указанием даты вступления в силу.
`;

export const TERMS_RU = `# Пользовательское соглашение Cumulus://Mail

**Редакция от {{EFFECTIVE_DATE}}.**

## 1. Стороны

Услуги оказывает {{OPERATOR_NAME}} ({{OPERATOR_FORM}}), адрес: {{OPERATOR_ADDRESS}}, далее — Оператор.
Пользователь — лицо, использующее сервис Cumulus://Mail.

## 2. Предмет

Оператор предоставляет доступ к сервису электронной почты Cumulus://Mail. Для доступа необходима
учётная запись Cumulus://ID. Состав функций зависит от выбранного тарифа.

## 3. Регистрация и учётная запись

Пользователь обязуется указывать достоверные сведения и отвечает за сохранность данных для входа.
Все действия, совершённые с использованием его учётной записи, считаются совершёнными им.

## 4. Допустимое использование

Запрещается использовать сервис для рассылки спама, распространения вредоносного программного
обеспечения, нарушения прав третьих лиц и совершения иных действий, противоречащих законодательству
Российской Федерации. Оператор вправе ограничить доступ при нарушении настоящего пункта.

## 5. Тарифы и оплата

Платные тарифы оплачиваются авансом за выбранный период. Условия возврата: {{REFUND_POLICY}}.

## 6. Доступность сервиса

Оператор принимает разумные меры для обеспечения доступности сервиса, но не гарантирует его
непрерывную работу. Плановые работы по возможности проводятся с предварительным уведомлением.

## 7. Ответственность

Ответственность Оператора ограничена суммой, уплаченной Пользователем за период, в котором возникло
основание для ответственности, если иное не установлено законом.

## 8. Персональные данные

Обработка персональных данных осуществляется в соответствии с Политикой конфиденциальности,
размещённой по адресу /legal/privacy.

## 9. Прекращение

Пользователь вправе прекратить использование сервиса и удалить учётную запись в любой момент.
Последствия удаления описаны в Политике конфиденциальности (раздел «Срок хранения»).

## 10. Применимое право и разрешение споров

{{GOVERNING_LAW}}

## 11. Изменения

Новая редакция публикуется на этой странице с указанием даты вступления в силу.
`;

export const TEMPLATES: Record<LegalDoc, string> = { privacy: PRIVACY_RU, terms: TERMS_RU };

export const TITLES: Record<LegalDoc, string> = {
  privacy: "Политика конфиденциальности",
  terms: "Пользовательское соглашение",
};

/**
 * Whether a filled document may be shown as final. It needs every placeholder filled **and** an
 * explicit `MAIL_LEGAL_RU_REVIEWED=yes`, set by someone who has had the wording checked by a lawyer.
 */
export function isReviewed(env: Record<string, string | undefined> = process.env): boolean {
  return env.MAIL_LEGAL_RU_REVIEWED?.trim().toLowerCase() === "yes";
}

/** Owner-supplied values, from `MAIL_LEGAL_RU_<FIELD>` environment variables. None are secret. */
export function valuesFromEnv(env: Record<string, string | undefined> = process.env): Values {
  const values: Values = {};
  for (const { key } of FIELDS) {
    const value = env[`MAIL_LEGAL_RU_${key}`]?.trim();
    if (value) values[key] = value;
  }
  return values;
}

export type Rendered = { title: string; markdown: string; missing: string[]; draft: boolean };

export function renderDoc(doc: LegalDoc, env: Record<string, string | undefined> = process.env): Rendered {
  const markdown = fill(TEMPLATES[doc], valuesFromEnv(env));
  const missing = unfilled(markdown);
  return { title: TITLES[doc], markdown, missing, draft: missing.length > 0 || !isReviewed(env) };
}
