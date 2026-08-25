# Швидкий старт

Одна повна програма, а потім розбір кожного її рядка. Вона підключається до реєстру, входить у
сесію, дізнається ціну імені, реєструє його, читає, скільки це коштувало, і виходить. Нічого не
пропущено: це файл цілком.

## Встановлення

```bash
npm install @epptools/sdk
```

Node.js 16 або новіший, без залежностей. Або просто з GitHub, з прив'язкою до тега випуску, якщо ви
волієте не залежати від доступності реєстру під час встановлення:

```bash
npm install github:epptools/node-sdk#v1.0.0
```

Так чи інакше він встановлюється як `@epptools/sdk`, тож `require('@epptools/sdk')` працює як
завжди. ESM теж підтримується: `import { Client, Config } from '@epptools/sdk';`.

Перш ніж щось запускати, вам потрібні чотири речі від реєстру: ваш **clID**, ваш **пароль**, **пакет
CA**, яким підписано серверний сертифікат реєстру, і ваша вихідна IP-адреса в білому списку для
цього clID. На публічній точці підключення немає ані клієнтського сертифіката, ані API-ключа —
автентифікація це clID плюс пароль поверх TLS.

## Програма

```js
'use strict';

const {
  Client, Config,
  EppError, CommandError, InsufficientFundsError, ObjectExistsError,
} = require('@epptools/sdk');

const NAME = 'example.com.ua';
const REGISTRANT = 'C1';

const client = new Client(new Config({
  host: 'epp.registry.example',
  port: 700,
  clid: 'EXAMPLE',
  password: process.env.EPP_PASSWORD,
  caFile: '/etc/epp/registry-ca.pem',
  lang: 'en',
  connectTimeout: 10000,
  readTimeout: 30000,
}));

async function main() {
  const greeting = await client.connect();
  console.log('connected to', greeting.value('svID'));

  const session = await client.login();
  for (const event of session.securityEvents()) {
    console.warn(`login ${event.level}: [${event.type}] ${event.text} ${event.exDate || ''}`);
  }

  const check = await client.domain.check([NAME], { create: 1 });
  if (check.isAvailable(NAME) !== true) {
    console.log(`${NAME} is not available: ${check.unavailableReason(NAME) || 'no reason given'}`);
    return;
  }

  const price = check.feeFor(NAME, 'create', 1);
  if (price === null) {
    console.log(`${NAME} is available but the registry quoted no price; stopping.`);
    return;
  }
  console.log(`${NAME} is available at ${price} ${check.fees()._currency} for one year`);

  const created = await client.domain.createBuilder(NAME)
    .years(1)
    .registrant(REGISTRANT)
    .adminContact(REGISTRANT)
    .techContact(REGISTRANT)
    .nameserver('ns1.example.com.ua')
    .nameserver('ns2.example.com.ua')
    .authInfo('D0main-Pw')
    .maxFee(price)
    .send();

  console.log('svTRID', created.svTRID());
  if (created.isPending()) {
    console.log('accepted, still being processed — the outcome will arrive as a poll notice');
  } else {
    console.log(`registered until ${created.expiryDate()}`);
    console.log(`charged ${created.feeAmount() || 'nothing'} ${created.feeCurrency() || ''}`);
  }

  const account = await client.balance();
  console.log(`balance ${account.currentBalance()}, available ${account.availableCredit()}`);

  await client.logout();
}

main()
  .catch((err) => {
    process.exitCode = 1;
    if (err instanceof InsufficientFundsError) {
      console.error('account cannot pay for this — top up before retrying:', err.message);
    } else if (err instanceof ObjectExistsError) {
      console.error('already registered:', err.subject() || NAME);
    } else if (err instanceof CommandError) {
      console.error(`registry refused with EPP ${err.eppCode}:`, err.message, err.reasons());
    } else if (err instanceof EppError) {
      console.error('client-side failure:', err.name, err.message);
    } else {
      console.error(err);
    }
  })
  .finally(() => client.disconnect());
```

Запускайте її з паролем в оточенні, ніколи не у файлі:

```bash
EPP_PASSWORD='your-secret' node register.js
```

## Що робить кожен рядок

### Імпорти

```js
const {
  Client, Config,
  EppError, CommandError, InsufficientFundsError, ObjectExistsError,
} = require('@epptools/sdk');
```

`Client` — це сесія; `Config` — її незмінні налаштування. Чотири класи помилок — це ті, на які ця
програма реагує по-різному; кожен збій, який здіймає бібліотека, успадковується від `EppError`, тож
остання гілка справді перехоплює будь-що з цієї бібліотеки. Повна ієрархія — на сторінці
[Помилки](errors.md).

### Створення клієнта

```js
const client = new Client(new Config({ ... }));
```

`Config` створюється один раз і ніколи не змінюється. Поле за полем:

| Поле тут | Навіщо |
|---|---|
| `host`, `port` | точка підключення реєстру. 700 — типове значення, і ви змінюєте його, лише якщо точка підключення переїхала |
| `clid`, `password` | ваші облікові дані. Пароль береться з оточення, щоб його не було у вашому репозиторії |
| `caFile` | **обов'язковий для цієї точки підключення.** Сертифікат на `epp.registry.example:700` видано власним приватним CA реєстру, якого немає в системному сховищі довіри, тож без цього рукостискання не вдасться |
| `lang` | мова повідомлень реєстру про результат: `en`, `uk`, `ua` чи `ru` |
| `connectTimeout`, `readTimeout` | **мілісекунди**, мінімум 1000. Менше значення відхиляється, а не підвищується мовчки |

Кожне поле, його типове значення і те, що станеться, якщо воно неправильне, — у
[Сесії](session.md#config).

### Підключення

```js
const greeting = await client.connect();
console.log('connected to', greeting.value('svID'));
```

`connect()` відкриває TLS-сокет і читає `<greeting>`, яке сервер надсилає без запиту. Він повертає це
привітання як [`Response`](responses.md), тож `value('svID')` дає вам ім'я сервера, а
`serviceObjUris()` / `serviceExtUris()` — простори імен об'єктів і розширень, які він підтримує.
Клієнт зберігає привітання і входить, оголошуючи рівно ці сервіси, тож сесію ніколи не буде
відхилено за запит того, чого сервер не пропонує.

Якщо цей рядок падає з `certificate verify failed`, то `caFile` не заданий або вказує не на той
пакет — [Сесія](session.md#коли-рукостискання-не-вдається) показує, як це перевірити.

### Вхід і читання того, що сервер каже про сесію

```js
const session = await client.login();
for (const event of session.securityEvents()) { ... }
```

`login()` надсилає `<login>` з вашим clID і паролем та повертає відповідь. Будь-що, крім 1000,
відхиляється: 2200 як `AuthError`, а решта відмов — сервіс, якого сервер не пропонує, мова, якої він
не підтримує, забагато одночасних сесій — як клас, що їм відповідає, бо кожна має власний спосіб
усунення, а називати їх усі помилкою автентифікації означає відправити вас міняти пароль, який тут
ні до чого.

`securityEvents()` — це блок RFC 8807: попередження сервера про *цю* сесію, наприклад клієнтський
сертифікат за три тижні до завершення строку або застарілий набір шифрів. На здоровій сесії список
порожній, тож ставтеся до будь-якого запису як до того, на що треба зреагувати. Див.
[Сесія](session.md#безпека-входу-rfc-8807).

### Чи вільне ім'я і скільки воно коштує

```js
const check = await client.domain.check([NAME], { create: 1 });
if (check.isAvailable(NAME) !== true) { ... }
```

`domain.check()` відповідає `<domain:check>` (RFC 5731). Вона нічого не змінює і нічого не коштує,
тож це найбезпечніша команда, яку варто надсилати першою. Другий аргумент — це запит тарифу за
RFC 8748 (*операція => роки*), який дізнається ціну в тому самому обміні.

Порівняння написано як `!== true`, а не як перевірка на хибність, і це навмисно: `isAvailable()`
повертає `true`, `false` або **`null`, коли у відповіді про це ім'я не сказано взагалі нічого**. «Реєстр
не відповів» — це не те саме, що «зайнято», а наступний рядок реєструє домен.

```js
const price = check.feeFor(NAME, 'create', 1);
```

`feeFor(name, operation, years)` повертає одне котирування, яке ви запитали, точним десятковим
рядком, або `null`, коли у відповіді такого котирування не було. `fees()` повертає всю таблицю за
іменами, якщо вам потрібні ще й причини та клас тарифу; `fees()._currency` — валюта, у якій реєстр
котирував. Ціни повністю розглянуто в [Балансі](balance.md).

### Реєстрація

```js
const created = await client.domain.createBuilder(NAME)
  .years(1)
  .registrant(REGISTRANT)
  ...
  .maxFee(price)
  .send();
```

Це плинна форма `domain.create(name, opts)` — та сама команда, той самий кадр, той самий
результат. Різниця в тому, що крок із друкарською помилкою — це метод, якого не існує, і ваш
редактор скаже вам про це, а не ключ, якого ніхто не читає. Нічого не надсилається до `send()`, а
білдер надсилає один раз: надіслати двічі означало б дві реєстрації і два списання. Див.
[Білдери](builders.md).

`.maxFee(price)` — це погодження тарифу, і воно є **стелею, а не ціною, яку встановлюєте ви**. Реєстр
стягує власну ціну; якщо ця ціна вища за погоджену вами — зміна тарифу, преміальне ім'я, застарілий
кеш — команду буде відхилено з 2004 і **нічого не буде стягнуто**, замість того щоб мовчки виставити
вам більше, ніж ви показали своєму клієнтові. Крок необов'язковий: пропустіть його, і команда піде
без нього, за ціною реєстру.

### Читання відповіді

```js
console.log('svTRID', created.svTRID());
if (created.isPending()) { ... } else { ... }
```

**Зберігайте `svTRID` поруч із доменом.** Це власний ідентифікатор операції в реєстрі і єдине
значення, за яким підтримка може її знайти; ваш `clTRID` не означає нічого ні для кого, крім вас.

`isPending()` істинний для коду відповіді **1001**: команду прийнято і виконують офлайн. Це не збій і
це не завершення. Ніколи не надсилайте її повторно «про всяк випадок» — стежте за
[чергою poll](poll.md) щодо результату і зіставте його за `svTRID`, який ви щойно зберегли.

`expiryDate()` — це власний рядок реєстру; не розбирайте і не переформатовуйте його. `feeAmount()` та
`feeCurrency()` — це те, що ця команда справді списала, повернуте розширенням тарифів, або `null`,
коли у відповіді не було блоку тарифу.

### Баланс

```js
const account = await client.balance();
console.log(`balance ${account.currentBalance()}, available ${account.availableCredit()}`);
```

`client.balance()` — це запит щодо облікового запису, а не щодо об'єкта. Обидві суми — точні
десяткові рядки; ніколи не перетворюйте їх на числа перед арифметикою.

### Вихід і закриття сокета

```js
await client.logout();
...
.finally(() => client.disconnect());
```

`logout()` надсилає `<logout>`, сервер відповідає 1500 і закриває зв'язок. `disconnect()` закриває
сокет локально, і його безпечно викликати незалежно від того, чи була сесія взагалі встановлена, —
саме тому він живе у `finally()`: виняток будь-де вище не повинен залишити сокет відкритим.

### Обробка помилок

```js
if (err instanceof InsufficientFundsError) { ... }
```

`InsufficientFundsError` (2104) заслуговує на власну гілку, бо із самим запитом усе гаразд: обліковий
запис не може заплатити, і кожна наступна платна команда падатиме так само, доки його не поповнять.
У пакеті операцій це та помилка, на якій треба зупинитися, а не пропустити її.

`ObjectExistsError` (2302) означає, що ім'я зайняли між перевіркою і створенням — справжня гонитва, а
не помилка. `err.subject()` — це об'єкт, який назвав реєстр, і це важливо, коли команда несла
кілька.

`CommandError` охоплює всі інші відмови; розгалужуйтеся за `err.eppCode` і читайте `err.reasons()`,
щоб дістати додатковий діагностичний текст, який додав реєстр. `EppError` перехоплює все інше, що
може здійняти ця бібліотека, тож ніщо не лишається без типу. У [Помилках](errors.md) є вся таблиця,
а також те, що робити, коли змінна команда впала і ви не можете сказати, чи вона відбулася.

## Куди далі

- [Сесія](session.md) — кожне поле `Config`, TLS і безпека входу
- [Команди](commands.md) — що повертає команда, ідентифікатори транзакцій, власні кадри
- [Домени](domains.md) — решта доменних методів
- [Помилки](errors.md) — таксономія збоїв і правило невідомого результату

---

[← Зміст посібника](README.md)
