# Команди

Усе, що ви надсилаєте після `<login>`, — це команда, і кожна команда в цій бібліотеці поводиться
однаково: складає один EPP-кадр, пише його, читає рівно одну відповідь і повертає
[`Response`](responses.md). Ця сторінка — про цю форму: що повертається, як ідентифікуються
транзакції, як вимкнути викидання винятків і як надіслати кадр, для якого в бібліотеці немає методу.

Окремі команди описано по об'єктах: [Домени](domains.md), [Контакти](contacts.md),
[Хости](hosts.md), [Poll](poll.md), [Баланс](balance.md).

## Що повертає команда

Кожна команда повертає `Promise<Response>`.

```js
const response = await client.domain.info('example.com.ua');
response.code();        // 1000
response.isSuccess();   // true для будь-якого 1xxx
response.svTRID();      // 'SRV-19700101103512-24191-00007'
```

Проміс **успішно завершується**, коли реєстр відповів кодом успіху (1000–1999), і **відхиляється** з
[`CommandError`](errors.md), коли він відповів 2000 або вище. Більше ніщо не відхиляє команду, окрім
збою транспорту, який приходить як `ConnectionError`, і поганого аргументу, який приходить як
`ValidationError` ще до того, як щось буде надіслано.

Коди успіху, які ви справді зустрінете:

| Код | Означає | Що робити |
|---|---|---|
| `1000` | виконано | продовжуйте; об'єкт у тому стані, який ви запитали |
| `1001` | прийнято, виконується офлайн | **не надсилайте повторно.** Стежте за [чергою poll](poll.md) щодо результату, зіставляючи за `svTRID` |
| `1300` | poll: черга порожня | припиніть спорожнення |
| `1301` | poll: повідомлення чекає | прочитайте його, потім підтвердьте |
| `1500` | вихід прийнято | сервер закриває з'єднання |

`1001` — саме той, на якому спотикаються. `response.isPending()` для нього істинний. Команду
прийнято і вона обробляється; це ані збій, ані завершена операція, і надіслати її ще раз «про всяк
випадок» — це шлях до того, щоб домен було зареєстровано та оплачено двічі.

Відповідь ніколи не несе частково розібраного кадру. Обрізана чи некоректна відповідь — це
`ConnectionError`, а не `Response`, який випадково читається як успіх.

## Перелік команд

| Метод | Команда EPP |
|---|---|
| **Сесія** — див. [Сесія](session.md) | |
| `Client.connectAndLogin(config)` | підключення + `<login>`, повертає готового клієнта |
| `client.connect()` | відкриває TLS і читає `<greeting>` |
| `client.hello()` | `<hello>` |
| `client.login(newPassword = null)` | `<login>`, з необов'язковою зміною пароля |
| `client.logout()` | `<logout>` |
| `client.disconnect()` | закриває сокет (без кадру) |
| `client.isConnected()` / `client.isLoggedIn()` | локальний стан (без кадру) |
| `client.throwOnFailure(value = true)` | перемикач, див. нижче (без кадру) |
| `client.setLogger(logger)` | перемикач, див. [Сесія](session.md#журналювання-із-замаскованими-секретами) |
| `client.frame()` / `client.request(frame)` | власні кадри, див. нижче |
| `client.balance()` | власний запит балансу — [Баланс](balance.md) |
| **Домени** — див. [Домени](domains.md) | |
| `client.domain.check(names, fee = null, currency = null)` | `<domain:check>` (RFC 5731), з необов'язковим запитом ціни за RFC 8748 |
| `client.domain.info(name, authInfo = null, hosts = 'all')` | `<domain:info>` |
| `client.domain.create(name, opts = {})` | `<domain:create>` |
| `client.domain.createBuilder(name)` | те саме, [крок за кроком](builders.md) |
| `client.domain.update(name, opts = {})` | `<domain:update>` |
| `client.domain.updateBuilder(name)` | те саме, [крок за кроком](builders.md) |
| `client.domain.renew(name, curExpDate, years = 1, fee = null)` | `<domain:renew>` |
| `client.domain.restore(name, fee = null)` | `<domain:update>` з `<rgp:restore op="request">` (RFC 3915) |
| `client.domain.transfer(op, name, authInfo = null, years = null, fee = null)` | `<domain:transfer>` |
| `client.domain.delete(name)` | `<domain:delete>` |
| **Контакти** — див. [Контакти](contacts.md) | |
| `client.contact.check(ids)` | `<contact:check>` (RFC 5733) |
| `client.contact.info(id, authInfo = null)` | `<contact:info>` |
| `client.contact.create(id, opts = {})` | `<contact:create>` |
| `client.contact.createAuto(opts = {})` | `<contact:create>` з `Contact.AUTO_ID`: ідентифікатор генерує реєстр |
| `client.contact.createBuilder(id, email)` | те саме, [крок за кроком](builders.md) |
| `client.contact.update(id, opts = {})` | `<contact:update>` |
| `client.contact.updateBuilder(id)` | те саме, [крок за кроком](builders.md) |
| `client.contact.delete(id)` | `<contact:delete>` |
| `client.contact.transfer(op, id, authInfo = null)` | `<contact:transfer>` |
| **Хости** — див. [Хости](hosts.md) | |
| `client.host.check(names)` | `<host:check>` (RFC 5732) |
| `client.host.info(name)` | `<host:info>` |
| `client.host.create(name, addresses = [])` | `<host:create>` |
| `client.host.update(name, opts = {})` | `<host:update>` |
| `client.host.updateBuilder(name)` | те саме, [крок за кроком](builders.md) |
| `client.host.delete(name, force = false)` | `<host:delete>`, з необов'язковим попереднім відкріпленням |
| **Poll** — див. [Poll](poll.md) | |
| `client.poll.request()` | `<poll op="req">` |
| `client.poll.ack(messageId)` | `<poll op="ack">` — **знищує повідомлення в реєстрі** |
| `client.poll.drain(handler, limit = 0)` | запит/обробка/підтвердження в порядку, який не може втратити повідомлення |

Чотири обробники ресурсів — `client.domain`, `client.contact`, `client.host`, `client.poll` —
створюються під час першого використання і використовуються повторно, тож тримати посилання на один
із них — те саме, що щоразу діставатися до нього через клієнта.

## Клієнтські ідентифікатори транзакцій

Кожна команда несе `clTRID`, який належить **вам**, і кожна відповідь несе `svTRID`, який належить
**реєстру**.

```js
const r = await client.domain.info('example.com.ua');
r.clTRID();   // 'NODEJS-SDK-20260816103012-24191-0003'  — повернуто з вашої команди
r.svTRID();   // 'SRV-19700101103512-24191-00007'     — власний запис реєстру
```

Бібліотека генерує `clTRID` за вас і гарантує його унікальність для кожної команди. Його форма така:

```
<clTRIDPrefix>-<UTC timestamp>-<process id>-<counter>
```

тож ідентифікатори з одного процесу мають спільний стабільний середній сегмент, ідентифікатори з
паралельних процесів не можуть збігтися, а вся конструкція сортується в журналі хронологічно.
Задайте `clTRIDPrefix` у [Config](session.md#config) так, щоб він ідентифікував вашу інтеграцію;
типове значення — `NODEJS-SDK`.

**Зберігайте `svTRID` поруч з об'єктом, якого стосувалася команда.** Це значення, за яким підтримка
знаходить операцію; `clTRID` не означає нічого ні для кого, крім вас. Записуйте обидва, на кожній
команді, зокрема на тих, що вдалися, — саме з тими, що вдалися, ви порівнюєте, коли пізніша не
вдається.

### Відповідь звіряється з командою

Перш ніж відповідь буде віддано вам, `clTRID`, який вона повторює, порівнюється з тим, що пішов. Якщо
вони не збігаються, з'єднання **закривається** і здіймається `ConnectionError`:

```
ConnectionError: Response does not belong to this command (sent clTRID …, received …)
  — the connection was desynchronised and has been closed.
```

Це варто зрозуміти, а не обходити. Без цієї перевірки відповідь, що належить попередній команді,
неможливо відрізнити від відповіді на цю: `renew('example2.com.ua')` повертає 1000 із датою завершення
строку для `example1.com.ua`, обидва тарифікуються, а ваші записи брешуть про обидва. Щойно зсуви
розійшлися, кожен наступний кадр у цьому потоці теж під підозрою — саме тому йде з'єднання, а не
лише команда.

Практичне правило, яке з цього випливає: **надсилайте по одній команді за раз.** Дочекайтеся кожної
відповіді, перш ніж писати наступний кадр. Якщо потрібна пропускна здатність, відкривайте більше
сесій, а не накладайте команди в одній — і спершу перевірте обмеження сесій у реєстрі.

## `throwOnFailure`

Типово код відповіді 2000 і вище відхиляє проміс із найточнішим [класом помилки](errors.md) для
цього коду. Вимкніть це, щоб читати коди самотужки:

```js
client.throwOnFailure(false);

const r = await client.domain.create('example.com.ua', { years: 1, registrant: 'C1' });
if (!r.isSuccess()) {
  console.error(r.code(), r.message(), r.errorReasons());
}
```

Він повертає клієнта, тож включається в ланцюжок, а `throwOnFailure(true)` повертає все як було. Три
речі, які слід знати, перш ніж ним користуватися:

- Це перемикач **на весь клієнт**, а не на окрему команду. Код в іншому місці вашого процесу, який
  ділить цього клієнта, теж перестане кидати винятки.
- `login()` усе одно відхиляється на результаті, відмінному від 1000. Сесію, яка не відкрилася,
  немає сенсу розглядати.
- `poll.drain()` усе одно відхиляється на відповіді, яка не несе ані повідомлення, ані порожньої
  черги, бо вивести «чергу спорожнено» з відмови означало б повідомити про успіх, не прочитавши
  нічого.

З вимкненими винятками ніщо не змушує вас дивитися на код. Це і є компроміс: проігнорований
`response.code()` — це збій, якого ваша програма ніколи не помітить, тоді як необроблене відхилення
проміса — це збій, якого вона не може не помітити.

## Параметри перевіряються ще до надсилання

Команди, які приймають об'єкт параметрів, приймають лише ті ключі, які описано. Невідомий ключ
відхиляється з `ValidationError`, який називає найближчий відомий:

```js
await client.domain.create('example.com.ua', { years: 1, secdns: { … } });
// ValidationError: domain:create does not accept 'secdns' (did you mean 'secDNS'?).
//                  Accepted: authInfo, contacts, fee, license, nameServers, nameservers,
//                  registrant, secDNS, years.
```

Альтернативою було б його проігнорувати, а проігнорований ключ мовчить у найгірший спосіб: команда
все одно йде, реєстр усе одно відповідає 1000, а тієї частини, яку ви просили, немає. `secdns`
замість `secDNS` зареєструє домен **непідписаним**; `nameservers` із друкарською помилкою зареєструє
його **без делегування**. У відповіді про це не буде ні слова, бо, з погляду реєстру, ви цього й не
просили. [Білдери](builders.md) знімають таку можливість остаточно — крок із друкарською помилкою є
методом, якого не існує.

## Власні кадри

Усе, чого не охоплює високорівневий API, можна зібрати за допомогою `Frame` і надіслати через
`client.request()`.

```js
const { Namespaces } = require('@epptools/sdk');

const frame = client.frame();                       // <command> зі згенерованим clTRID
const check = frame.ns(frame.verb('check'), Namespaces.DOMAIN, 'domain:check');
frame.ns(check, Namespaces.DOMAIN, 'domain:name', 'example.com.ua');

const response = await client.request(frame);       // або client.request(rawXmlString)
console.log(response.availability());
```

Користуйтеся `client.frame()`, а не `Frame.command(...)`, якщо у вас немає причини вчинити інакше:
він проставляє згенерований `clTRID`, а саме це дає змогу зіставити відповідь із командою. Якщо ви
все ж подаєте власний, протокол дозволяє від 3 до 64 символів, і реєстр може повернути його
нормалізованим до цих меж.

### API класу `Frame`

| Метод | Що робить |
|---|---|
| `Frame.command(clTRID)` | починає кадр `<command>` із цим ідентифікатором транзакції |
| `frame.verb(name)` | додає дієслово команди — `check`, `info`, `create`, `update`, `renew`, `transfer`, `delete`, `poll`, `login`, `logout` — і повертає його |
| `frame.extension()` | повертає елемент `<extension>`, створюючи його один раз під час першого використання |
| `frame.epp(parent, name, text = null, attrs = {})` | додає нащадка в базовому просторі імен `epp-1.0` |
| `frame.ns(parent, nsUri, qname, text = null, attrs = {})` | додає нащадка з простором імен, напр. `('domain:name', …)` у просторі імен домену |
| `frame.toXml()` | серіалізує кадр |

І `epp()`, і `ns()` повертають елемент, який вони додали, тож вкладення робиться передаванням його
назад як наступного батька. Атрибути на дієслові задаються напряму:

```js
const transfer = frame.verb('transfer');
transfer.attrs.op = 'request';
```

Кадр гарантує порядок нащадків із RFC 5730 — вміст команди, потім необов'язковий `<extension>`, потім
`<clTRID>` останнім — і екранує кожне значення, яке серіалізує, тож ніщо з переданого вами не може
зламати XML. `toXml()` безпечно викликати більше одного разу: серіалізувати кадр, щоб записати його
в журнал, а потім надіслати, не лишає позаду двох елементів `<clTRID>`, які були б невалідними за
схемою і притягнули б голий 2001.

Зверніть увагу, що кадр, який ви серіалізуєте самотужки, **не** маскується. Якщо ви журналюєте
результат `toXml()`, затріть `<pw>`, `<newPW>` та `<authInfo>`, перш ніж він потрапить на диск.

### Простори імен

`Namespaces` експортує константи протоколу, тож URI ви ніколи не набираєте:

| Константа | URI | Для чого |
|---|---|---|
| `Namespaces.EPP` | `urn:ietf:params:xml:ns:epp-1.0` | базовий протокол (RFC 5730) |
| `Namespaces.DOMAIN` | `urn:ietf:params:xml:ns:domain-1.0` | домени (RFC 5731) |
| `Namespaces.HOST` | `urn:ietf:params:xml:ns:host-1.0` | хости (RFC 5732) |
| `Namespaces.CONTACT` | `urn:ietf:params:xml:ns:contact-1.0` | контакти (RFC 5733) |
| `Namespaces.SECDNS` | `urn:ietf:params:xml:ns:secDNS-1.1` | DNSSEC (RFC 5910) |
| `Namespaces.RGP` | `urn:ietf:params:xml:ns:rgp-1.0` | викуп / відновлення (RFC 3915) |
| `Namespaces.FEE` | `urn:ietf:params:xml:ns:epp:fee-1.0` | ціни та погодження тарифу (RFC 8748) |
| `Namespaces.LOGINSEC` | `urn:ietf:params:xml:ns:epp:loginSec-1.0` | безпека входу (RFC 8807) |
| `Namespaces.XSI` | `http://www.w3.org/2001/XMLSchema-instance` | атрибути екземпляра схеми |
| `Namespaces.LOGINSEC_SENTINEL` | `[LOGIN-SECURITY]` | зарезервоване значення `<pw>`, яке означає «справжній пароль у `<loginSec:pw>`» |
| `Namespaces.DEFAULT_OBJ_URIS` | | сервіси об'єктів, які оголошуються, коли привітання не перелічило жодного |
| `Namespaces.DEFAULT_EXT_URIS` | | сервіси розширень, які оголошуються, коли привітання не перелічило жодного |

Відповідь читається за **локальним іменем елемента і URI простору імен**, ніколи за префіксом, тож
власний кадр, який ви зібрали з іншими префіксами, все одно читається звичайними аксесорами
[`Response`](responses.md) — зокрема `value()`, `values()` і `resData()` для всього, для чого в
бібліотеці немає іменованого аксесора.

### Власні розширення вашого реєстру

Кожен URI вище визначений якимось RFC і однаковий у будь-якого реєстру у світі. З ВЛАСНИМИ
розширеннями реєстру — ліцензією на торгову марку, ціною, балансом облікового запису — це вже не так,
і константи для них тут не буде: немає значення, яке було б правильним більш ніж для одного реєстру.

Вони **визначаються з `<greeting>`**. Будь-який сервер перелічує те, що підтримує, ще до того як ви
щось надішлете, тому одразу після `connect()` клієнт уже знає:

```js
await client.connect();

client.registryExtUri();      // наприклад 'http://registry.example/epp/registry-1.0', або null
client.registryBalanceUri();  // наприклад 'http://registry.example/epp/balance-1.0', або null
```

`null` означає, що цей сервер такого розширення не оголошує, — це факт про сервер, а не помилка.
Команди, яким розширення потрібне, про це кажуть, а не здогадуються: `domain.create` з `license`,
`host.delete` з `force` і `balance()` кидають `ConfigError`, називаючи, що саме знадобилося, і
перелічуючи, що сервер запропонував. У цій відмові й полягає суть. Розширення, надіслане у просторі імен,
якого сервер не знає, **ігнорується, а не відхиляється**, — тобто здогадка повернулася б як
`1000 OK` з мовчки невстановленою ліцензією.

Визначення зіставляє останній сегмент оголошеного URI — `.../registry-1.0`, `urn:…:balance`, — і це
домовленість, якої реєстри дотримуються, а не правило, дотримання якого хтось примушує. Якщо реєстр
називає свої розширення інакше, задайте їх самі — тоді привітання не питають:

```js
const config = new Config({
  host: 'epp.registry.example', clid: 'EXAMPLE', password: '...',
  registryExtUri: 'urn:example:params:xml:ns:myreg-1.0',
  registryBalanceUri: 'urn:example:params:xml:ns:myreg-balance-1.0',
});
```

### Коди відповіді за іменами

У `ResultCode` є іменована константа для кожного коду з RFC 5730, тож розгалужуватися можна без
голих чисел:

```js
const { ResultCode } = require('@epptools/sdk');

if (response.code() === ResultCode.SUCCESS_PENDING) { /* 1001 */ }
if (err.eppCode === ResultCode.OBJECT_EXISTS) { /* 2302 */ }
```

Повний перелік і те, що кожен код означає для вашого наступного кроку, — у
[Помилках](errors.md#коди-відповіді).

---

[← Зміст посібника](README.md)
