# Билдеры

Билдер собирает одну команду по одному именованному шагу и отправляет её вызовом `send()`.

Собственного XML он не строит. `send()` передаёт накопленные опции прямо в обычный метод, поэтому
билдер и равнозначный ему объект опций дают **идентичный кадр**, и любая проверка, действующая для
одного, действует и для другого. Разница в том, что объект опций принимает любой ключ, а в билдере
опечататься не в чем: `.yeras(1)` — несуществующий метод, и редактор скажет вам об этом прямо при
наборе.

```js
const response = await client.domain.createBuilder('example.com.ua')
  .years(1)
  .registrant('C1')
  .adminContact('C1')
  .techContact('EXAMPLE-C2').techContact('EXAMPLE-C3')
  .nameserver('ns1.example.com.ua').nameserver('ns2.example.com.ua')
  .authInfo('D0main-Pw')
  .maxFee('180.00', 'UAH')
  .send();
```

## У каких команд есть билдер

| Билдер | Откуда получить | `send()` вызывает | Описан |
|---|---|---|---|
| `DomainCreateBuilder` | `client.domain.createBuilder(name)` | `domain.create(name, opts)` | [ниже](#domaincreatebuilder) |
| `DomainUpdateBuilder` | `client.domain.updateBuilder(name)` | `domain.update(name, opts)` | [ниже](#domainupdatebuilder) |
| `ContactCreateBuilder` | `client.contact.createBuilder(id, email)` | `contact.create(id, opts)` | [ниже](#contactcreatebuilder) |
| `ContactUpdateBuilder` | `client.contact.updateBuilder(id)` | `contact.update(id, opts)` | [ниже](#contactupdatebuilder) |
| `HostUpdateBuilder` | `client.host.updateBuilder(name)` | `host.update(name, opts)` | [ниже](#hostupdatebuilder) |

Эти пять — ровно те команды, которые принимают объект опций. Всё остальное — `check`, `info`,
`delete`, `renew`, `transfer`, `restore`, `host.create`, команды poll — принимает позиционные
аргументы, яснее которых билдер не сделает, поэтому его там и нет. Классы экспортируются
(`require('@epptools/sdk').DomainCreateBuilder`) ради типизации, но экземпляры вы получаете от
обработчика, а не создаёте сами.

Каждый шаг возвращает билдер, поэтому шаги связываются в цепочку в любом порядке. Порядок вызовов на
кадр не влияет: библиотека выводит каждый элемент в том порядке, который закрепляет схема. Порядок
*внутри* списка сохраняется — серверы имён, контакты и адреса уходят в том порядке, в каком вы их
добавили.

---

## Четыре правила, действующие для каждого билдера

### Каждый списочный шаг накапливает

Шаг, принимающий список, добавляет к тому, что уже есть. Повторный вызов, передача нескольких
значений сразу или и то и другое — это одно и то же:

```js
.techContact('EXAMPLE-C2').techContact('EXAMPLE-C3')   // идентично
.techContact('EXAMPLE-C2', 'EXAMPLE-C3')               // вот этому
```

Поэтому сборка в цикле или под условием читается так же, как и работает:

```js
const b = client.domain.createBuilder('example.com.ua').years(1).registrant('C1');
for (const host of nameserversForThisCustomer) b.nameserver(host);
if (customerWantsPrivacy) b.authInfo(freshSecret());
await b.send();
```

Значения обрезаются по краям, а пустое или состоящее из одних пробелов отбрасывается, а не
отправляется пустым элементом: пустой `<domain:hostObj/>` — это синтаксическая ошибка на стороне
реестра, а не пропуск.

Шаги с одним значением — `years`, `registrant`, `authInfo`, `license`, `maxFee`, `maxSigLife` и шаги
`change*` — **заменяют**. Побеждает последний вызов.

### До `send()` ничего не отправляется

До этого момента билдер — обычное значение. Его можно хранить, передать в другую функцию, положить в
словарь или разглядывать. Никакой сокет не трогается, и никакие деньги не тратятся.

Именно это делает цикл выше безопасным: кадр пишется один раз, в конце, из готового набора опций.

### `toOptions()` возвращает то, что принимает прямой вызов

```js
toOptions()   // => объект опций, глубокая копия
```

Результат — ровно тот объект, который принимает равнозначный прямой вызов, так что его можно
записать в журнал, поставить в очередь, сравнить с ожидаемым или передать методу самостоятельно:

```js
const builder = client.domain.createBuilder('example.com.ua')
  .years(1).registrant('C1').maxFee('100.00', 'UAH');

console.log(builder.toOptions());
// { years: 1, registrant: 'C1', fee: { amount: '100.00', currency: 'UAH' } }

// Та же команда, отправленная другим способом:
await client.domain.create('example.com.ua', builder.toOptions());
```

**Это копия, причём глубокая.** Если бы возвращался живой объект, он менялся бы под вызывающим при
каждом новом шаге, и записанное в журнал могло бы разойтись с отправленным, — а это ровно то, чего
журнал аудита делать не должен. Копия означает ещё и то, что изменения возвращённого объекта на
билдер никак не влияют.

`toOptions()` ничего не отправляет и ничего не тратит. Это холостой прогон.

### Билдер отправляет один раз

```js
const b = client.domain.createBuilder('example.com.ua').years(1).registrant('C1');
await b.send();
await b.send();
// ValidationError: DomainCreateBuilder has already been sent. A builder carries one command;
//                  build another rather than re-sending this one.
```

Билдер — это команда, которая ещё не случилась. Отправить её дважды означало бы две регистрации и два
списания, и второе никогда не входило в намерения вызывающего — тем более внутри обёртки повторных
попыток, которая перезапускает блок при сбое. Соберите новый: они бесплатны.

Если первый `send()` не удался и вы действительно хотите попробовать снова, соберите свежий билдер —
но сначала прочитайте [правило неизвестного исхода](errors.md#когда-невозможно-понять-произошло-ли-это),
потому что изменяющая команда, сбойнувшая на потерянном ответе, могла уже произойти.

## Когда ошибка обнаруживается

| Обнаруживается на шаге | Обнаруживается в `send()` |
|---|---|
| сумма цены, которая не является простым десятичным числом | смешение моделей серверов имён в одной команде |
| DS-запись без дайджеста, запись ключа без открытого ключа | одновременная установка и очистка `authInfo` домена |
| пустая роль контакта | создание контакта без адреса электронной почты |
| неизвестное раскрываемое поле | всё, что отклоняет сам реестр |
| `removeAllDnssec()` вместе с поимённым удалением, в любом порядке | |

Всё из левого столбца поднимает `ValidationError` прямо из шага, и стек указывает на написанную вами
строку. Всё из правого — свойство готовой команды, и судить о нём можно только тогда, когда вы её
запросили: всё ещё до сборки кадра и всё ещё как `ValidationError`. См. [Ошибки](errors.md).

---

## DomainCreateBuilder

```js
client.domain.createBuilder(name)   // => DomainCreateBuilder
```

`send()` вызывает [`domain.create(name, opts)`](domains.md#create), поэтому каждая опция и каждый код
ответа с той страницы действуют здесь без изменений.

| Шаг | Аргументы | Что задаёт |
|---|---|---|
| `years(years)` | целое число лет | `years` → `<domain:period unit="y">`. Не указывайте его — и реестр применит своё значение по умолчанию |
| `registrant(handle)` | идентификатор контакта | `registrant` → `<domain:registrant>` |
| `contact(role, ...handles)` | имя роли, один или несколько идентификаторов | добавляет в `contacts[role]` → по одному `<domain:contact type="role">` на идентификатор |
| `adminContact(...handles)` | идентификаторы | то же с ролью, закреплённой как `admin` |
| `techContact(...handles)` | идентификаторы | то же для `tech` |
| `billingContact(...handles)` | идентификаторы | то же для `billing` |
| `nameserver(host)` | одно имя сервера имён | добавляет в `nameservers` → `<domain:hostObj>` |
| `nameservers(...hosts)` | имена серверов имён | то же, по нескольку за раз |
| `nameserverWithGlue(host, ...addresses)` | имя и его IP-адреса | добавляет `{ name, addresses }` → `<domain:hostAttr>` со встроенными glue-адресами |
| `authInfo(password)` | код авторизации трансфера | `authInfo` → `<domain:authInfo><domain:pw>` |
| `license(number)` | номер товарного знака или лицензии | `license` → `<registry:license>`, если ваш реестр его требует |
| `maxFee(amount, currency = null)` | десятичная строка и, при желании, валюта | `fee` → `<fee:create>`, **потолок** суммы, с которой вы согласны |
| `dsRecord(keyTag, alg, digestType, digest)` | одна DS-запись | добавляет в `secDNS.dsData` → `<secDNS:dsData>` |
| `dsRecordWithKey(keyTag, alg, digestType, digest, flags, protocol, keyAlg, pubKey)` | DS-запись и DNSKEY, из которого она посчитана | то же, но с `<secDNS:keyData>`, вложенным внутрь записи |
| `keyRecord(flags, protocol, alg, pubKey)` | один открытый ключ | добавляет в `secDNS.keyData` |
| `maxSigLife(seconds)` | время жизни подписи в секундах | `secDNS.maxSigLife` |
| `toOptions()` | — | опции, глубокая копия |
| `send()` | — | `Promise<Response>` |

### Что здесь важно

**Две модели серверов имён — это выбор, а не смесь.** `nameserver()` называет
[объект хоста](hosts.md), который у реестра уже есть; `nameserverWithGlue()` встраивает адреса рядом
с именем. RFC 5731 делает `<domain:ns>` выбором между ними, поэтому одна команда использует одну
модель. Использование обеих поднимает `ValidationError` в `send()`, а не зарабатывает от реестра
голый `2001`, который не называет ни одного поля. Спросите свой реестр, какую модель он принимает.

**`maxFee()` — это потолок, а не цена.** Реестр списывает свою цену; если она выше вашего
согласования, команда отклоняется с кодом `2004` и ничего не списывается. Передавайте ту сумму,
которую вы назвали клиенту, — см.
[Потолок суммы, с которой вы согласны](balance.md#ограничение-суммы-которую-вы-согласны-заплатить).

**`maxSigLife()` едет здесь только рядом с записью.** RFC 5910 требует в `<secDNS:create>` хотя бы
одну DS-запись или запись ключа, поэтому create, несущий время жизни подписи и ни одного ключа, не
выводит блок DNSSEC вовсе — вместо невалидного пустого. В [update](#domainupdatebuilder) оно может
ехать одно.

**`dsRecordWithKey()` стоит попробовать.** Реестр, который принимает DNSKEY рядом с DS-записью, сам
сверяет дайджест с ключом и ловит опечатку в дайджесте до того, как она дойдёт до зоны. Реестр,
который его не принимает, отвечает `2306`, а не игнорирует лишний элемент, так что попытка не стоит
ничего, кроме отказа.

### Разобранные примеры

```js
// Подписанная регистрация со встроенными glue-адресами, контактами в двух ролях и потолком цены.
const created = await client.domain.createBuilder('example.com.ua')
  .years(2)
  .registrant('C1')
  .adminContact('C1')
  .techContact('EXAMPLE-C2', 'EXAMPLE-C3')
  .nameserverWithGlue('ns1.example.com.ua', '203.0.113.1', '2001:db8::1')
  .nameserverWithGlue('ns2.example.com.ua', '203.0.113.2')
  .authInfo('D0main-Pw')
  .dsRecord(12345, 13, 2, '49FD46E6C4B45C55D4AC')
  .maxSigLife(1209600)
  .maxFee('195.00', 'UAH')
  .send();

created.code();          // 1000 или 1001, если реестр взял её в офлайн-обработку
created.expiryDate();    // собственная строка реестра
created.feeAmount();     // сколько списано на самом деле
created.svTRID();        // сохраните рядом с доменом
```

```js
// Реестр, который требует номер товарного знака или лицензии для регистрации имени.
await client.domain.createBuilder('example.com.ua')
  .years(1)
  .registrant('C1')
  .license('TM-2026-000123')
  .send();
```

---

## DomainUpdateBuilder

```js
client.domain.updateBuilder(name)   // => DomainUpdateBuilder
```

`send()` вызывает [`domain.update(name, opts)`](domains.md#update).

### В какой блок попадает шаг — в этом вся команда

Update в EPP — это **дельта**, а не замена. Он несёт три блока, и блок, в котором сидит изменение,
*и есть* инструкция:

| Блок | Что означает | Какие шаги туда попадают |
|---|---|---|
| `<domain:add>` | присоединить это, сохранив всё, что уже есть | `addNameserver`, `addNameservers`, `addContact`, `addStatus` |
| `<domain:rem>` | отсоединить ровно это, оставив остальное | `remNameserver`, `remNameservers`, `remContact`, `remStatus` |
| `<domain:chg>` | заменить это значение | `changeRegistrant`, `changeAuthInfo`, `clearAuthInfo` |
| `<extension>` | отдельное отображение, едущее следом | `restore`, `license`, `maxFee`, все шаги `secDNS` |

Операции «сделать серверы имён равными этому списку» здесь нет, потому что её нет и в EPP. Чтобы
заменить делегирование, вы добавляете новые имена и удаляете старые **в одной и той же команде**, —
это заодно единственный способ обойтись без окна, в котором домену не хватает серверов имён:

```js
await client.domain.updateBuilder('example.com.ua')
  .addNameserver('ns3.example.com.ua')
  .remNameserver('ns2.example.com.ua')
  .send();
```

Отправите один `add` — старый сервер имён останется. Отправите один `rem` — домен может опуститься
ниже минимума своей зоны и перестать разрешаться. Имена шагов делают блок видимым прямо в вызове, и
в этом смысл: читая цепочку, вы видите, что команда делает с объектом.

| Шаг | Аргументы | Блок | Что задаёт |
|---|---|---|---|
| `addNameserver(host)` | одно имя | `add` | добавляет в `add.ns` |
| `addNameservers(...hosts)` | имена | `add` | то же, по нескольку за раз |
| `remNameserver(host)` | одно имя | `rem` | добавляет в `rem.ns` |
| `remNameservers(...hosts)` | имена | `rem` | то же, по нескольку за раз |
| `addContact(role, ...handles)` | роль и идентификаторы | `add` | добавляет в `add.contacts[role]` |
| `remContact(role, ...handles)` | роль и идентификаторы | `rem` | добавляет в `rem.contacts[role]` |
| `addStatus(...statuses)` | клиентские значения статуса | `add` | добавляет в `add.statuses` → `<domain:status s="…">` |
| `remStatus(...statuses)` | клиентские значения статуса | `rem` | добавляет в `rem.statuses` |
| `changeRegistrant(handle)` | идентификатор контакта | `chg` | `chg.registrant` |
| `changeAuthInfo(password)` | новый код авторизации трансфера | `chg` | `chg.authInfo` |
| `clearAuthInfo()` | — | `chg` | `chg.clearAuthInfo` → `<domain:authInfo><domain:null/>`, что **убирает** код |
| `restore()` | — | расширение | `restore` → `<rgp:restore op="request"/>` (RFC 3915) |
| `license(number)` | номер товарного знака или лицензии | расширение | `license` → `<registry:license>` |
| `maxFee(amount, currency = null)` | десятичное значение, валюта необязательна | расширение | `fee` → `<fee:update>`, потолок |
| `addDsRecord(keyTag, alg, digestType, digest)` | одна DS-запись | расширение | `secDNS.add.dsData` |
| `remDsRecord(keyTag, alg, digestType, digest)` | одна DS-запись | расширение | `secDNS.rem.dsData` — каждое поле должно совпадать с тем, что хранит реестр |
| `addKeyRecord(flags, protocol, alg, pubKey)` | один открытый ключ | расширение | `secDNS.add.keyData` |
| `remKeyRecord(flags, protocol, alg, pubKey)` | один открытый ключ | расширение | `secDNS.rem.keyData` |
| `removeAllDnssec()` | — | расширение | `secDNS.remAll` → `<secDNS:rem><secDNS:all>true` |
| `maxSigLife(seconds)` | секунды | расширение | `secDNS.maxSigLife`; здесь может ехать одно |
| `toOptions()` | — | — | опции, глубокая копия |
| `send()` | — | — | `Promise<Response>` |

Устанавливать и снимать можно только **клиентские** статусы: `clientHold`,
`clientDeleteProhibited`, `clientUpdateProhibited`, `clientTransferProhibited`,
`clientRenewProhibited`. Статусы `server*` принадлежат реестру, а `ok` и `inactive` вычисляются — их
не задаёт никто.

### Что здесь важно

**`clearAuthInfo()` — это ответ на утёкший код авторизации трансфера**, и это не то же самое, что
задать пустой код. Пустой пароль — значение, которое владелец кода всё ещё может предъявить, так что
домен остаётся ровно настолько же уводимым, а утечка не закрыта. Убирает код только null-форма.
Новый код задавайте через `changeAuthInfo()`, когда он снова понадобится клиенту, — и никогда оба в
одной команде: схема не способна выразить и то и другое, и такая пара отклоняется как
`ValidationError` в `send()`.

**`removeAllDnssec()` и поимённые удаления взаимно исключают друг друга**, в любом порядке. У
протокола нет способа выразить и то и другое, поэтому второй из двух вызовов поднимает
`ValidationError` прямо на шаге, где сообщение может об этом сказать. Чтобы сменить набор ключей без
окна, в котором домен не подписан, удалите всё и добавьте новый ключ одной командой:

```js
await client.domain.updateBuilder('example.com.ua')
  .removeAllDnssec()
  .addDsRecord(54321, 13, 2, 'A1B2C3D4E5F60718293A')
  .send();
```

**`restore()` — это самостоятельная команда.** Восстановление не может сопровождаться `add`, `rem`
или `chg`; такую комбинацию реестр отклоняет. [`client.domain.restore(name, fee)`](domains.md#restore)
— та же команда в одном вызове, и браться стоит именно за неё:

```js
await client.domain.updateBuilder('example.com.ua').restore().maxFee('1000.00').send();
// идентично:
await client.domain.restore('example.com.ua', '1000.00');
```

**Update не возвращает ничего о самом объекте.** Перечитайте его через `info()`, когда нужно
убедиться в результате, а не в том, что команду приняли.

### Разобранный пример

```js
// Переделегировать, передать домен новому владельцу, запретить трансферы и сменить код
// авторизации — одна команда, один обмен, одно атомарное изменение в реестре.
const r = await client.domain.updateBuilder('example.com.ua')
  .addNameserver('ns3.example.com.ua')
  .remNameserver('ns2.example.com.ua')
  .addContact('tech', 'EXAMPLE-C4')
  .remContact('tech', 'EXAMPLE-C3')
  .addStatus('clientTransferProhibited')
  .changeRegistrant('EXAMPLE-C9')
  .changeAuthInfo('N3w-D0main-Pw')
  .send();

r.code();        // 1000 или 1001, если реестр взял её в офлайн-обработку
r.isPending();
```

---

## ContactCreateBuilder

```js
client.contact.createBuilder(id, email)   // => ContactCreateBuilder
```

`send()` вызывает [`contact.create(id, opts)`](contacts.md#create).

**Идентификатор и адрес электронной почты — это аргументы, а не шаги**, потому что RFC 5733 требует
и то и другое, а про шаг можно забыть. Передайте в качестве идентификатора `Contact.AUTO_ID`, чтобы
идентификатор выдал реестр, — см. [createAuto](contacts.md#createauto).

| Шаг | Аргументы | Что задаёт |
|---|---|---|
| `internationalAddress(parts)` | адрес в ASCII | добавляет блок `<contact:postalInfo type="int">` |
| `localizedAddress(parts)` | тот же адрес местным письмом | добавляет блок `<contact:postalInfo type="loc">` |
| `voice(number)` | `+CC.NNNNNNNNN` | `voice` → `<contact:voice>` |
| `fax(number)` | та же форма | `fax` → `<contact:fax>` |
| `authInfo(password)` | код авторизации трансфера контакта | `authInfo` → `<contact:authInfo><contact:pw>` |
| `publish(...fields)` | имена раскрываемых полей | `disclose` с флагом «публиковать» |
| `withhold(...fields)` | имена раскрываемых полей | `disclose` с флагом «скрывать» |
| `toOptions()` | — | опции, глубокая копия |
| `send()` | — | `Promise<Response>` |

### Части адреса

Оба адресных шага принимают один объект. Имена здесь написаны полностью и сами отображаются в
сокращения, принятые на проводе:

| Ключ | Обязателен | На проводе |
|---|---|---|
| `name` | да | `<contact:name>` |
| `city` | да | `<contact:city>` |
| `countryCode` | да | `<contact:cc>` — двухбуквенный код |
| `street` | нет | по одному `<contact:street>` на элемент, до 3 |
| `org` | нет | `<contact:org>` |
| `stateProvince` | нет | `<contact:sp>` |
| `postalCode` | нет | `<contact:pc>` |

`int` — форма в ASCII, которую принимает любой реестр и которая переживает печать, отправку почтой и
чтение системой, не знающей кириллицы. `loc` — местное письмо, адрес в том виде, как его написал сам
регистрант. Хотя бы одна форма обязательна; присылайте обе всегда, когда есть обе, — ничего не
отбрасывается, и `info` возвращает всё, что вы прислали. Кириллица в блоке `int` отклоняется с кодом
`2005`.

### Раскрытие данных

`publish()` и `withhold()` говорят одно и то же в противоположных направлениях, и каждый из них
**заменяет** любую предыдущую настройку раскрытия — они не складываются. Выберите одно направление и
перечислите поля, к которым оно относится; со всем неперечисленным поступят наоборот.

Имена полей — `name`, `org`, `addr`, `voice`, `fax` и `email`. Всё прочее поднимает
`ValidationError` прямо на шаге:

```js
.withhold('addres')
// ValidationError: 'addres' is not a disclosable field. Use: name, org, addr, voice, fax, email.
```

`name`, `org` и `addr` существуют по одному на каждую почтовую форму, поэтому обе формы называются
за вас. Скрыть только форму в ASCII, оставив местную публичной, — это настройка приватности, которая
выглядит применённой и таковой не является.

### Разобранный пример

```js
const r = await client.contact.createBuilder('C1', 'contact@example.com')
  .internationalAddress({
    name: 'Ivan Petrenko',
    org: 'Pryklad LLC',
    street: ['vul. Khreshchatyk 1'],
    city: 'Kyiv',
    postalCode: '01001',
    countryCode: 'UA',
  })
  .localizedAddress({
    name: 'Іван Петренко',
    org: 'ТОВ «Приклад»',
    street: ['вул. Хрещатик 1'],
    city: 'Київ',
    postalCode: '01001',
    countryCode: 'UA',
  })
  .voice('+380.441234567')
  .authInfo('C0ntact-Pw')
  .withhold('addr', 'voice')
  .send();

r.objectName();    // 'C1' — идентификатор
r.createdDate();   // собственная строка реестра
```

```js
// Своей схемы именования нет: пусть идентификатор выдаст реестр, а вы его прочитаете.
const { Contact } = require('@epptools/sdk');

const minted = await client.contact.createBuilder(Contact.AUTO_ID, 'contact@example.com')
  .internationalAddress({ name: 'Pryklad LLC', city: 'Kyiv', countryCode: 'UA' })
  .send();

await saveContactHandle(minted.objectName());   // единственное место, где он появляется
```

---

## ContactUpdateBuilder

```js
client.contact.updateBuilder(id)   // => ContactUpdateBuilder
```

`send()` вызывает [`contact.update(id, opts)`](contacts.md#update).

| Шаг | Аргументы | Блок | Что задаёт |
|---|---|---|---|
| `changeInternationalAddress(parts)` | части, которые нужно изменить | `chg` | добавляет частичный `<contact:postalInfo type="int">` |
| `changeLocalizedAddress(parts)` | части, которые нужно изменить | `chg` | то же для `type="loc"` |
| `changeVoice(number)` | `+CC.NNNNNNNNN` | `chg` | `chg.voice` |
| `changeFax(number)` | та же форма | `chg` | `chg.fax` |
| `changeEmail(email)` | адрес электронной почты | `chg` | `chg.email` |
| `changeAuthInfo(password)` | новый код авторизации трансфера | `chg` | `chg.authInfo` |
| `publish(...fields)` | раскрываемые поля | `chg` | `chg.disclose`, флаг «публиковать» |
| `withhold(...fields)` | раскрываемые поля | `chg` | `chg.disclose`, флаг «скрывать» |
| `addStatus(...statuses)` | клиентские значения статуса | `add` | `addStatuses` → по одному `<contact:status s="…">` на элемент |
| `remStatus(...statuses)` | клиентские значения статуса | `rem` | `remStatuses` |
| `toOptions()` | — | — | опции, глубокая копия |
| `send()` | — | — | `Promise<Response>` |

Всё, кроме двух шагов со статусами, попадает в `<contact:chg>` — блок **замены**: что вы назвали, то
и устанавливается, что не назвали, то остаётся как есть.

### Внутри адреса решает наличие ключа

Внутри `changeInternationalAddress()` и `changeLocalizedAddress()` вся инструкция — в том, **есть**
ли ключ:

| Что вы пишете | Что происходит |
|---|---|
| ключа нет | поле не отправляется, и реестр сохраняет то значение, которое у него есть |
| ключ со значением | поле устанавливается в это значение |
| ключ со значением `''` | поле отправляется пустым, что его **очищает** |

Пустая строка — единственный способ убрать необязательное поле: `org`, `stateProvince` или
`postalCode`. Другого написания для «удали это» не существует.

**Адресный блок — это последовательность с обязательными городом и страной**, поэтому он выводится
целиком или не выводится вовсе. Трогаете любую его часть — `street`, `city`, `stateProvince`,
`postalCode`, `countryCode` — задавайте `city` и `countryCode` в том же вызове. Если их не указать,
они уйдут пустыми элементами и сотрут город у контакта, которому вы собирались лишь сменить номер
дома.

Изменение одной формы никогда не трогает другую.

### Здесь нет `clearAuthInfo()`

`changeAuthInfo()` **заменяет** код авторизации трансфера контакта. RFC 5731 даёт домену null-форму
для его удаления; RFC 5733 ничего равнозначного для контакта не определяет, поэтому код контакта
можно заменить, но не убрать. Не хватайтесь вместо этого за пустой пароль: пустое значение — это
по-прежнему значение, которое владелец может предъявить.

### Разобранный пример

```js
// Клиент переехал и отказался от названия компании. Форма местным письмом и всё остальное
// в контакте остаются ровно как были.
await client.contact.updateBuilder('C1')
  .changeInternationalAddress({
    street: ['vul. Svobody 1'],
    city: 'Lviv',
    countryCode: 'UA',
    org: '',                       // '' ОЧИЩАЕТ его; отсутствие ключа сохранило бы значение
  })
  .changeEmail('new-contact@example.com')
  .addStatus('clientUpdateProhibited')
  .send();
```

---

## HostUpdateBuilder

```js
client.host.updateBuilder(name)   // => HostUpdateBuilder
```

`send()` вызывает [`host.update(name, opts)`](hosts.md#update).

| Шаг | Аргументы | Блок | Что задаёт |
|---|---|---|---|
| `addAddress(ip)` | один литерал IPv4 или IPv6 | `add` | добавляет в `addAddresses` → `<host:addr>` |
| `addAddresses(...ips)` | несколько литералов | `add` | то же, по нескольку за раз |
| `remAddress(ip)` | один литерал | `rem` | добавляет в `remAddresses` |
| `remAddresses(...ips)` | несколько литералов | `rem` | то же, по нескольку за раз |
| `addStatus(...statuses)` | клиентские значения статуса | `add` | `addStatuses` → `<host:status s="…">` |
| `remStatus(...statuses)` | клиентские значения статуса | `rem` | `remStatuses` |
| `toOptions()` | — | — | опции, глубокая копия |
| `send()` | — | — | `Promise<Response>` |

IPv4 и IPv6 различаются за вас и записываются в атрибут `ip`, поэтому классифицировать адрес
самостоятельно и ошибиться в метке вам не придётся.

Адреса и статусы, идущие в одну сторону, делят один блок, а блок, в котором ничего нет, не
выводится. Отправляйте хотя бы одно изменение: кадр, не выражающий ни одного, приходит в реестр как
команда, которая ни о чём не просит, и возвращается с кодом `2003`.

**Шага переименования нет** — это замысел, а не упущение; см.
[Хост нельзя переименовать](hosts.md#хост-нельзя-переименовать).

### Разобранный пример

```js
// Сменить адрес сервера имён одной командой, чтобы он ни разу не остался без адреса: подчинённый
// хост без адреса отклоняется (2003), а две команды проходят через это состояние.
await client.host.updateBuilder('ns1.example.com.ua')
  .addAddress('203.0.113.11')
  .remAddress('203.0.113.10')
  .addStatus('clientUpdateProhibited')
  .send();
```

---

## Билдеры и TypeScript

Каждый шаг типизирован, `toOptions()` возвращает тот же интерфейс, который принимает прямой вызов
(`DomainCreateOptions`, `ContactUpdateOptions` и так далее), а каждый шаг возвращает `this`, поэтому
цепочка сохраняет свой тип. Опечатка в названии шага — это ошибка компиляции, а не сюрприз во время
выполнения, и ради этого билдеры и существуют.

```ts
import { Client, Config, DomainCreateBuilder } from '@epptools/sdk';

const b: DomainCreateBuilder = client.domain.createBuilder('example.com.ua');
b.years(1).registrant('C1');
const opts = b.toOptions();     // DomainCreateOptions
```

---

[← Оглавление руководства](README.md) · [Домены](domains.md) · [Контакты](contacts.md) ·
[Хосты](hosts.md) · [Баланс и цены](balance.md) · [Ошибки](errors.md)
