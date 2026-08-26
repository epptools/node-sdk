# Білдери

Білдер збирає одну команду по іменованому кроку за раз і надсилає її через `send()`.

Власного XML він не будує. `send()` віддає зібрані параметри прямо у звичайний метод, тож білдер і
рівнозначний йому об'єкт параметрів дають **ідентичний кадр**, і кожна перевірка, що діє для одного,
діє й для другого. Різниця в тому, що об'єкт параметрів приймає будь-який ключ, а в білдера немає
ключа, у якому можна помилитися: `.yeras(1)` — це метод, якого не існує, і ваш редактор скаже вам про
це просто під час набору.

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

## Які команди мають білдер

| Білдер | Звідки береться | Що викликає `send()` | Опис |
|---|---|---|---|
| `DomainCreateBuilder` | `client.domain.createBuilder(name)` | `domain.create(name, opts)` | [нижче](#domaincreatebuilder) |
| `DomainUpdateBuilder` | `client.domain.updateBuilder(name)` | `domain.update(name, opts)` | [нижче](#domainupdatebuilder) |
| `ContactCreateBuilder` | `client.contact.createBuilder(id, email)` | `contact.create(id, opts)` | [нижче](#contactcreatebuilder) |
| `ContactUpdateBuilder` | `client.contact.updateBuilder(id)` | `contact.update(id, opts)` | [нижче](#contactupdatebuilder) |
| `HostUpdateBuilder` | `client.host.updateBuilder(name)` | `host.update(name, opts)` | [нижче](#hostupdatebuilder) |

Ці п'ять — це рівно ті команди, які приймають об'єкт параметрів. Усе інше — `check`, `info`,
`delete`, `renew`, `transfer`, `restore`, `host.create`, команди poll — приймає позиційні аргументи,
яких білдер не зробив би зрозумілішими, тож його там немає. Класи експортуються
(`require('@epptools/sdk').DomainCreateBuilder`) для типізації, але екземпляри ви берете з
обробника, а не створюєте самі.

Кожен крок повертає білдер, тож кроки з'єднуються в ланцюжок у будь-якому порядку. Порядок, у якому
ви їх викликаєте, на кадр не впливає — бібліотека виводить кожен елемент у порядку, який фіксує
схема. Порядок *усередині* списку зберігається: сервери імен, контакти й адреси йдуть у тому
порядку, у якому ви їх додали.

---

## Чотири правила, які діють для кожного білдера

### Кожен списковий крок накопичує

Крок, який приймає список, додає до того, що вже є. Викликати його ще раз, передати кілька значень
одразу або зробити і те, і те — це одне й те саме:

```js
.techContact('EXAMPLE-C2').techContact('EXAMPLE-C3')   // ідентичне
.techContact('EXAMPLE-C2', 'EXAMPLE-C3')               // цьому
```

Тож збирання в циклі або за умовою читається так само, як і поводиться:

```js
const b = client.domain.createBuilder('example.com.ua').years(1).registrant('C1');
for (const host of nameserversForThisCustomer) b.nameserver(host);
if (customerWantsPrivacy) b.authInfo(freshSecret());
await b.send();
```

Значення обрізаються з боків, а порожнє чи з самих лише пробілів відкидається, а не надсилається
порожнім елементом: порожній `<domain:hostObj/>` — це для реєстру синтаксична помилка, а не
пропуск.

Кроки з одним значенням — `years`, `registrant`, `authInfo`, `license`, `maxFee`, `maxSigLife` і
кроки `change*` — **замінюють**. Виграє останній виклик.

### Нічого не надсилається до `send()`

Доти білдер — це звичайне значення. Ви можете його зберегти, передати в іншу функцію, покласти в
словник або оглянути. Жодного сокета не зачеплено і жодних грошей не витрачено.

Саме це робить безпечним цикл вище: кадр пишеться один раз, наприкінці, із завершеного набору
параметрів.

### `toOptions()` повертає те, що приймає прямий виклик

```js
toOptions()   // => об'єкт параметрів, глибока копія
```

Результат — це рівно той об'єкт, який приймає рівнозначний прямий виклик, тож ви можете записати
його в журнал, поставити в чергу, порівняти з очікуваним або передати в метод самотужки:

```js
const builder = client.domain.createBuilder('example.com.ua')
  .years(1).registrant('C1').maxFee('100.00', 'UAH');

console.log(builder.toOptions());
// { years: 1, registrant: 'C1', fee: { amount: '100.00', currency: 'UAH' } }

// Та сама команда, надіслана в інший спосіб:
await client.domain.create('example.com.ua', builder.toOptions());
```

**Це копія, причому глибока.** Віддавати живий об'єкт означало б, що він змінюється під викликачем
щоразу, коли додається ще один крок, — тож те, що ви записали в журнал, і те, що ви надіслали, могло
б розійтися, а це саме те, чого журнал аудиту не має права робити ніколи. Копія також означає, що
зміни у поверненому об'єкті нічого не змінюють у білдері.

`toOptions()` нічого не надсилає і нічого не витрачає. Це пробний прогін.

### Білдер надсилає один раз

```js
const b = client.domain.createBuilder('example.com.ua').years(1).registrant('C1');
await b.send();
await b.send();
// ValidationError: DomainCreateBuilder has already been sent. A builder carries one command;
//                  build another rather than re-sending this one.
```

Білдер — це команда, яка ще не сталася. Надіслати його двічі означало б дві реєстрації і два
списання, і другого викликач ніколи не мав на увазі — найменше з усього всередині обгортки повторних
спроб, яка перезапускає блок після збою. Зберіть інший; вони безплатні.

Якщо перший `send()` не вдався і ви справді хочете спробувати ще раз, зберіть новий білдер — і
спершу прочитайте [правило невідомого результату](errors.md#коли-неможливо-сказати-чи-це-сталося),
бо змінна команда, яка впала через втрачену відповідь, могла вже відбутися.

---

## Коли помилку буде виловлено

| Виловлюється на кроці | Виловлюється в `send()` |
|---|---|
| сума тарифу, яка не є простим десятковим числом | змішування моделей серверів імен в одній команді |
| DS-запис без дайджесту, запис ключа без відкритого ключа | одночасне задання і очищення `authInfo` домену |
| порожня роль контакту | створення контакту без електронної пошти |
| невідоме поле для розкриття | будь-що, від чого відмовляється сам реєстр |
| `removeAllDnssec()` разом з іменованим видаленням, у будь-якому порядку | |

Усе з лівої колонки здіймає `ValidationError` із самого кроку, і стек указує на рядок, який ви
написали. Усе з правої є властивістю завершеної команди, тож про це можна судити лише тоді, коли ви
її попросите, — усе ще до складання кадру і все ще `ValidationError`. Див. [Помилки](errors.md).

---

## DomainCreateBuilder

```js
client.domain.createBuilder(name)   // => DomainCreateBuilder
```

`send()` викликає [`domain.create(name, opts)`](domains.md#create), тож кожен параметр і кожен код
відповіді з тієї сторінки діють тут без змін.

| Крок | Аргументи | Що задає |
|---|---|---|
| `years(years)` | ціла кількість років | `years` → `<domain:period unit="y">`. Пропустіть його — і реєстр застосує власне типове значення |
| `registrant(handle)` | ідентифікатор контакту | `registrant` → `<domain:registrant>` |
| `contact(role, ...handles)` | назва ролі, один або кілька ідентифікаторів | додає до `contacts[role]` → по одному `<domain:contact type="role">` на ідентифікатор |
| `adminContact(...handles)` | ідентифікатори | те саме з роллю, зафіксованою як `admin` |
| `techContact(...handles)` | ідентифікатори | те саме для `tech` |
| `billingContact(...handles)` | ідентифікатори | те саме для `billing` |
| `nameserver(host)` | одне ім'я сервера імен | додає до `nameservers` → `<domain:hostObj>` |
| `nameservers(...hosts)` | імена серверів імен | те саме, кілька за раз |
| `nameserverWithGlue(host, ...addresses)` | ім'я та його IP-адреси | додає `{ name, addresses }` → `<domain:hostAttr>` із вбудованими glue-адресами |
| `authInfo(password)` | код авторизації трансферу | `authInfo` → `<domain:authInfo><domain:pw>` |
| `license(number)` | номер торгової марки або ліцензії | `license` → `<registry:license>`, якщо реєстр його вимагає |
| `maxFee(amount, currency = null)` | десятковий рядок, необов'язково валюта | `fee` → `<fee:create>`, **стеля** того, на що ви погоджуєтесь |
| `dsRecord(keyTag, alg, digestType, digest)` | один DS-запис | додає до `secDNS.dsData` → `<secDNS:dsData>` |
| `dsRecordWithKey(keyTag, alg, digestType, digest, flags, protocol, keyAlg, pubKey)` | DS-запис і DNSKEY, з якого його обчислено | те саме, з `<secDNS:keyData>`, вкладеним усередину запису |
| `keyRecord(flags, protocol, alg, pubKey)` | один відкритий ключ | додає до `secDNS.keyData` |
| `maxSigLife(seconds)` | час життя підпису в секундах | `secDNS.maxSigLife` |
| `toOptions()` | — | параметри, глибока копія |
| `send()` | — | `Promise<Response>` |

### Примітки, що мають значення

**Дві моделі серверів імен — це вибір, а не суміш.** `nameserver()` називає
[об'єкт хоста](hosts.md), який реєстр уже тримає; `nameserverWithGlue()` вбудовує адреси разом з
іменем. RFC 5731 робить `<domain:ns>` вибором між ними, тож одна команда користується однією
моделлю. Використання обох здіймає `ValidationError` у `send()`, а не притягує від реєстру голий
`2001`, який не називає жодного поля. Спитайте свій реєстр, яку модель він приймає.

**`maxFee()` — це стеля, а не ціна.** Реєстр стягує власну ціну; якщо ця ціна вища за ваше
погодження, команду буде відхилено з `2004` і нічого не буде стягнуто. Передавайте ту цифру, яку ви
назвали клієнтові — див.
[Обмеження суми, яку ви погоджуєтеся сплатити](balance.md#обмеження-суми-яку-ви-погоджуєтеся-сплатити).

**`maxSigLife()` подорожує тут лише поруч із записом.** RFC 5910 вимагає щонайменше одного DS-запису
чи запису ключа в `<secDNS:create>`, тож create, який несе час життя і жодного ключа, не виводить
блоку DNSSEC узагалі, а не виводить невалідний порожній. На [оновленні](#domainupdatebuilder) він
може подорожувати сам.

**`dsRecordWithKey()` варто спробувати.** Реєстр, який приймає DNSKEY поруч із DS-записом, звіряє
дайджест із ключем за вас і ловить помилку в наборі дайджесту ще до того, як вона дійде до зони.
Реєстр, який його не приймає, відповідає `2306`, а не ігнорує зайвий елемент, тож спроба не коштує
нічого, крім відмови.

### Розібрані приклади

```js
// Підписана реєстрація з вбудованими glue-адресами, контактами у двох ролях і стелею ціни.
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

created.code();          // 1000 або 1001, коли реєстр забрав це в офлайн
created.expiryDate();    // власний рядок реєстру
created.feeAmount();     // скільки він справді списав
created.svTRID();        // збережіть поруч із доменом
```

```js
// Реєстр, який вимагає номер торгової марки або ліцензії для реєстрації імені.
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

`send()` викликає [`domain.update(name, opts)`](domains.md#update).

### Те, у який блок потрапляє крок, і є всією командою

EPP-оновлення — це **дельта**, а не заміна. Воно несе три блоки, і блок, у якому сидить зміна, *і є*
інструкцією:

| Блок | Означає | Кроки, які туди потрапляють |
|---|---|---|
| `<domain:add>` | приєднати оце, зберігши все, що вже є | `addNameserver`, `addNameservers`, `addContact`, `addStatus` |
| `<domain:rem>` | від'єднати рівно оце, лишивши решту | `remNameserver`, `remNameservers`, `remContact`, `remStatus` |
| `<domain:chg>` | замінити це значення | `changeRegistrant`, `changeAuthInfo`, `clearAuthInfo` |
| `<extension>` | окреме відображення, що їде поруч | `restore`, `license`, `maxFee`, кожен крок `secDNS` |

Тут немає операції «встанови сервери імен у цей список», бо в EPP такої немає. Щоб замінити
делегування, ви додаєте нові імена і видаляєте старі **в одній команді**, і це ж єдиний спосіб
зробити це без вікна, у якому домен недоделеговано:

```js
await client.domain.updateBuilder('example.com.ua')
  .addNameserver('ns3.example.com.ua')
  .remNameserver('ns2.example.com.ua')
  .send();
```

Надішліть сам лише `add` — і старий сервер імен залишиться. Надішліть сам лише `rem` — і домен може
опуститися нижче мінімуму своєї зони й перестати резолвитися. Назви кроків роблять блок видимим
просто у виклику, і в цьому суть: читаючи ланцюжок, ви бачите, що команда робить з об'єктом.

| Крок | Аргументи | Блок | Що задає |
|---|---|---|---|
| `addNameserver(host)` | одне ім'я | `add` | додає до `add.ns` |
| `addNameservers(...hosts)` | імена | `add` | те саме, кілька за раз |
| `remNameserver(host)` | одне ім'я | `rem` | додає до `rem.ns` |
| `remNameservers(...hosts)` | імена | `rem` | те саме, кілька за раз |
| `addContact(role, ...handles)` | роль та ідентифікатори | `add` | додає до `add.contacts[role]` |
| `remContact(role, ...handles)` | роль та ідентифікатори | `rem` | додає до `rem.contacts[role]` |
| `addStatus(...statuses)` | клієнтські статуси | `add` | додає до `add.statuses` → `<domain:status s="…">` |
| `remStatus(...statuses)` | клієнтські статуси | `rem` | додає до `rem.statuses` |
| `changeRegistrant(handle)` | ідентифікатор контакту | `chg` | `chg.registrant` |
| `changeAuthInfo(password)` | новий код авторизації трансферу | `chg` | `chg.authInfo` |
| `clearAuthInfo()` | — | `chg` | `chg.clearAuthInfo` → `<domain:authInfo><domain:null/>`, що **видаляє** код |
| `restore()` | — | розширення | `restore` → `<rgp:restore op="request"/>` (RFC 3915) |
| `license(number)` | номер торгової марки / ліцензії | розширення | `license` → `<registry:license>` |
| `maxFee(amount, currency = null)` | десяткове число, необов'язково валюта | розширення | `fee` → `<fee:update>`, стеля |
| `addDsRecord(keyTag, alg, digestType, digest)` | один DS-запис | розширення | `secDNS.add.dsData` |
| `remDsRecord(keyTag, alg, digestType, digest)` | один DS-запис | розширення | `secDNS.rem.dsData` — кожне поле має збігатися з тим, що тримає реєстр |
| `addKeyRecord(flags, protocol, alg, pubKey)` | один відкритий ключ | розширення | `secDNS.add.keyData` |
| `remKeyRecord(flags, protocol, alg, pubKey)` | один відкритий ключ | розширення | `secDNS.rem.keyData` |
| `removeAllDnssec()` | — | розширення | `secDNS.remAll` → `<secDNS:rem><secDNS:all>true` |
| `maxSigLife(seconds)` | секунди | розширення | `secDNS.maxSigLife`; тут може подорожувати сам |
| `toOptions()` | — | — | параметри, глибока копія |
| `send()` | — | — | `Promise<Response>` |

Задавати й знімати можна лише **клієнтські** статуси: `clientHold`, `clientDeleteProhibited`,
`clientUpdateProhibited`, `clientTransferProhibited`, `clientRenewProhibited`. Статуси `server*`
належать реєстру, а `ok` та `inactive` обчислюються — їх не встановлює ніхто.

### Примітки, що мають значення

**`clearAuthInfo()` — це відповідь на витік коду трансферу**, і це не те саме, що встановити
порожній. Порожній пароль — це значення, яке той, хто його має, все одно може подати, тож домен
лишається рівно таким самим рухомим, як і був, а витік не закрито. Видаляє код лише нульова форма.
Задайте новий код через `changeAuthInfo()`, коли клієнтові він знадобиться знову, — і ніколи не
робіть обидва в одній команді: схема не може виразити і те, і те, а таку пару відхиляє
`ValidationError` у `send()`.

**`removeAllDnssec()` та іменовані видалення взаємно виключні**, у будь-якому порядку. Протокол не
має способу виразити і те, і те, тож другий із двох здіймає `ValidationError` просто на кроці, де
повідомлення може це пояснити. Щоб змінити набір ключів без вікна без підпису, видаліть усе і додайте
новий ключ однією командою:

```js
await client.domain.updateBuilder('example.com.ua')
  .removeAllDnssec()
  .addDsRecord(54321, 13, 2, 'A1B2C3D4E5F60718293A')
  .send();
```

**`restore()` — це самостійна команда.** Відновлення не може супроводжуватися `add`, `rem` чи `chg`;
реєстр відхиляє таке поєднання. [`client.domain.restore(name, fee)`](domains.md#restore) — це та сама
команда одним викликом, і саме за нею варто тягнутися:

```js
await client.domain.updateBuilder('example.com.ua').restore().maxFee('1000.00').send();
// те саме, що й:
await client.domain.restore('example.com.ua', '1000.00');
```

**Оновлення не повертає нічого про об'єкт.** Перечитайте його через `info()`, коли вам треба
підтвердити результат, а не сам факт прийняття.

### Розібраний приклад

```js
// Переделегувати, передати домен новому власникові, замкнути його від трансферів і змінити
// код авторизації трансферу — одна команда, один обмін, одна атомарна зміна в реєстрі.
const r = await client.domain.updateBuilder('example.com.ua')
  .addNameserver('ns3.example.com.ua')
  .remNameserver('ns2.example.com.ua')
  .addContact('tech', 'EXAMPLE-C4')
  .remContact('tech', 'EXAMPLE-C3')
  .addStatus('clientTransferProhibited')
  .changeRegistrant('EXAMPLE-C9')
  .changeAuthInfo('N3w-D0main-Pw')
  .send();

r.code();        // 1000 або 1001, коли реєстр забрав це в офлайн
r.isPending();
```

---

## ContactCreateBuilder

```js
client.contact.createBuilder(id, email)   // => ContactCreateBuilder
```

`send()` викликає [`contact.create(id, opts)`](contacts.md#create).

**Ідентифікатор і електронна пошта є аргументами, а не кроками**, бо RFC 5733 вимагає обох, а крок —
це те, що можна забути. Передайте як ідентифікатор `Contact.AUTO_ID`, щоб його згенерував реєстр, —
див. [createAuto](contacts.md#createauto).

| Крок | Аргументи | Що задає |
|---|---|---|
| `internationalAddress(parts)` | адреса в ASCII | додає блок `<contact:postalInfo type="int">` |
| `localizedAddress(parts)` | та сама адреса локальним письмом | додає блок `<contact:postalInfo type="loc">` |
| `voice(number)` | `+CC.NNNNNNNNN` | `voice` → `<contact:voice>` |
| `fax(number)` | та сама форма | `fax` → `<contact:fax>` |
| `authInfo(password)` | код авторизації трансферу контакту | `authInfo` → `<contact:authInfo><contact:pw>` |
| `publish(...fields)` | імена полів, які можна розкривати | `disclose` із прапорцем «публікувати» |
| `withhold(...fields)` | імена полів, які можна розкривати | `disclose` із прапорцем «приховати» |
| `toOptions()` | — | параметри, глибока копія |
| `send()` | — | `Promise<Response>` |

### Частини адреси

Обидва кроки з адресою приймають один об'єкт. Імена тут написані повністю, а у скорочення каналу
передачі їх відображають за вас:

| Ключ | Обов'язковий | У каналі передачі |
|---|---|---|
| `name` | так | `<contact:name>` |
| `city` | так | `<contact:city>` |
| `countryCode` | так | `<contact:cc>` — дволітерний код |
| `street` | ні | по одному `<contact:street>` на запис, до 3 |
| `org` | ні | `<contact:org>` |
| `stateProvince` | ні | `<contact:sp>` |
| `postalCode` | ні | `<contact:pc>` |

`int` — це ASCII-форма, яку приймає кожен реєстр і яка переживає друк, надсилання поштою і читання
системою, що не знає кирилиці. `loc` — це локальне письмо, адреса так, як її справді написав
реєстрант. Потрібна щонайменше одна форма; надсилайте обидві щоразу, коли маєте обидві, бо тут нічого
не відкидається, а `info` повертає все, що ви надіслали. Кирилицю в блоці `int` відхиляють із
`2005`.

### Розкриття даних

`publish()` і `withhold()` кажуть те саме в протилежних напрямках, і кожен із них **замінює** будь-яке
попереднє налаштування розкриття — вони не додаються одне до одного. Оберіть один напрямок і
перелічіть поля, до яких він застосовується; усе, чого немає в переліку, отримує протилежне
поводження.

Імена полів такі: `name`, `org`, `addr`, `voice`, `fax` та `email`. Будь-що інше здіймає
`ValidationError` просто на кроці:

```js
.withhold('addres')
// ValidationError: 'addres' is not a disclosable field. Use: name, org, addr, voice, fax, email.
```

`name`, `org` та `addr` існують по одному на кожну поштову форму, тож обидві форми названо за вас.
Приховати лише ASCII-форму, лишивши локальну публічною, означало б налаштування приватності, яке
читається як застосоване, але таким не є.

### Розібраний приклад

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

r.objectName();    // 'C1' — ідентифікатор
r.createdDate();   // власний рядок реєстру
```

```js
// Немає власної схеми найменування: хай ідентифікатор згенерує реєстр, а ви прочитайте його назад.
const { Contact } = require('@epptools/sdk');

const minted = await client.contact.createBuilder(Contact.AUTO_ID, 'contact@example.com')
  .internationalAddress({ name: 'Pryklad LLC', city: 'Kyiv', countryCode: 'UA' })
  .send();

await saveContactHandle(minted.objectName());   // єдине місце, де з'являється згенерований ідентифікатор
```

---

## ContactUpdateBuilder

```js
client.contact.updateBuilder(id)   // => ContactUpdateBuilder
```

`send()` викликає [`contact.update(id, opts)`](contacts.md#update).

| Крок | Аргументи | Блок | Що задає |
|---|---|---|---|
| `changeInternationalAddress(parts)` | частини, які треба змінити | `chg` | додає частковий `<contact:postalInfo type="int">` |
| `changeLocalizedAddress(parts)` | частини, які треба змінити | `chg` | те саме для `type="loc"` |
| `changeVoice(number)` | `+CC.NNNNNNNNN` | `chg` | `chg.voice` |
| `changeFax(number)` | та сама форма | `chg` | `chg.fax` |
| `changeEmail(email)` | адреса електронної пошти | `chg` | `chg.email` |
| `changeAuthInfo(password)` | новий код авторизації трансферу | `chg` | `chg.authInfo` |
| `publish(...fields)` | поля, які можна розкривати | `chg` | `chg.disclose`, прапорець «публікувати» |
| `withhold(...fields)` | поля, які можна розкривати | `chg` | `chg.disclose`, прапорець «приховати» |
| `addStatus(...statuses)` | клієнтські статуси | `add` | `addStatuses` → по одному `<contact:status s="…">` на запис |
| `remStatus(...statuses)` | клієнтські статуси | `rem` | `remStatuses` |
| `toOptions()` | — | — | параметри, глибока копія |
| `send()` | — | — | `Promise<Response>` |

Усе, крім двох кроків зі статусами, потрапляє в `<contact:chg>`, а це блок **заміни**: те, що ви
назвали, буде задано, те, чого ви не назвали, лишиться недоторканим.

### Адресу ЗАМІНЮЮТЬ цілком, а не зливають по полях

`changeInternationalAddress()` і `changeLocalizedAddress()` передають реєстрові блок, який
**заміщає** той, що реєстр тримає. Їх не зливають поле за полем, тож усе, чого ви не подали,
зникає:

| Ви пишете | Що станеться |
|---|---|
| ключ містить значення | полю задається це значення |
| ключ містить `''` | поле надсилається порожнім, що його **очищає** |
| ключа немає | поле не надсилається — і реєстр видаляє те, що тримав |

RFC 5733 можна прочитати як «не подавайте — і реєстр лишить своє значення», бо кожна складова
`chgPostalInfoType` необов'язкова, але це читання небезпечне. Проти реєстру, який заміщає блок, —
причому **кожна з тих команд відповідає 1000** — блок, надісланий без `org`, повертається вже без
організації, а блок, у якому був самий лише `org`, лишає контакт узагалі без поштової адреси: без
імені, вулиці, міста, індексу та країни.

Саме тому `name`, `city` і `countryCode` обов'язкові в кожній зміні адреси, і білдер без них
відмовляє. Вони тримають кадр валідним, але не здатні повернути поле, якого ви не подали.
**Спершу прочитайте блок і поверніть його назад разом зі своєю зміною.**

Зміна однієї форми ніколи не зачіпає другої: `int` і `loc` адресуються окремо.

### Тут немає `clearAuthInfo()`

`changeAuthInfo()` **замінює** код авторизації трансферу контакту. RFC 5731 дає домену нульову форму
для видалення такого коду; RFC 5733 не визначає рівнозначної для контакту, тож код контакту можна
замінити, але не видалити. Не тягніться за порожнім паролем як за замінником: порожнє значення — це
все одно значення, яке той, хто його має, може подати.

### Розібраний приклад

```js
// Клієнт переїхав і відмовився від назви компанії. Спершу читаємо блок: усе, чого ви не подасте,
// буде видалено, тож незмінні частини теж мають поїхати разом зі зміною.
const current = (await client.contact.info('C1')).postalInfo().int;

await client.contact.updateBuilder('C1')
  .changeInternationalAddress({
    ...current,                    // name і все інше, що тримає реєстр
    street: ['vul. Svobody 1'],
    city: 'Lviv',
    countryCode: 'UA',
    org: '',                       // '' ОЧИЩАЄ його — і тут його очистило б також відсутнє поле
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

`send()` викликає [`host.update(name, opts)`](hosts.md#update).

| Крок | Аргументи | Блок | Що задає |
|---|---|---|---|
| `addAddress(ip)` | один літерал IPv4 або IPv6 | `add` | додає до `addAddresses` → `<host:addr>` |
| `addAddresses(...ips)` | кілька літералів | `add` | те саме, кілька за раз |
| `remAddress(ip)` | один літерал | `rem` | додає до `remAddresses` |
| `remAddresses(...ips)` | кілька літералів | `rem` | те саме, кілька за раз |
| `addStatus(...statuses)` | клієнтські статуси | `add` | `addStatuses` → `<host:status s="…">` |
| `remStatus(...statuses)` | клієнтські статуси | `rem` | `remStatuses` |
| `toOptions()` | — | — | параметри, глибока копія |
| `send()` | — | — | `Promise<Response>` |

IPv4 та IPv6 розрізняються за вас і записуються в атрибут `ip`, тож ви ніколи не класифікуєте адресу
самі і ніколи не позначаєте її хибно.

Адреси і статуси, що йдуть в один бік, ділять один блок, а блок, у якому нічого немає, не
виводиться. Надсилайте щонайменше одну зміну: кадр, який не виражає жодної, доходить до реєстру як
команда, яка ні про що не просить, і повертається з `2003`.

**Кроку перейменування немає** — за задумом, а не через недогляд; див.
[Хост неможливо перейменувати](hosts.md#хост-неможливо-перейменувати).

### Розібраний приклад

```js
// Змінити адресу сервера імен однією командою, щоб він ніколи не лишався без адреси: підпорядкований
// хост без жодної відхиляється (2003), а в двох командах ви проходите через цей стан.
await client.host.updateBuilder('ns1.example.com.ua')
  .addAddress('203.0.113.11')
  .remAddress('203.0.113.10')
  .addStatus('clientUpdateProhibited')
  .send();
```

---

## Білдери і TypeScript

Кожен крок типізовано, `toOptions()` повертає той самий інтерфейс, який приймає прямий виклик
(`DomainCreateOptions`, `ContactUpdateOptions` тощо), і кожен крок повертає `this`, тож ланцюжок
зберігає свій тип. Крок із друкарською помилкою є помилкою компіляції, а не несподіванкою під час
виконання, і саме заради цього білдери й існують.

```ts
import { Client, Config, DomainCreateBuilder } from '@epptools/sdk';

const b: DomainCreateBuilder = client.domain.createBuilder('example.com.ua');
b.years(1).registrant('C1');
const opts = b.toOptions();     // DomainCreateOptions
```

---

[← Зміст посібника](README.md) · [Домени](domains.md) · [Контакти](contacts.md) ·
[Хости](hosts.md) · [Баланс і ціни](balance.md) · [Помилки](errors.md)
