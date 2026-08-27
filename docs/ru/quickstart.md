# Быстрый старт

Одна законченная программа, а затем разбор каждой её строки. Она подключается к реестру, входит в
сессию, узнаёт цену имени, регистрирует его, читает, во сколько это обошлось, и выходит. Ничего не
опущено: это весь файл целиком.

## Установка

```bash
npm install @epptools/sdk
```

Node.js 16 или новее, без зависимостей. Либо напрямую с GitHub, с привязкой к тегу релиза, если вы
предпочитаете не зависеть от доступности реестра пакетов в момент установки:

```bash
npm install github:epptools/node-sdk#v1.1.1
```

В обоих случаях пакет ставится как `@epptools/sdk`, поэтому `require('@epptools/sdk')` работает как
обычно. ESM тоже поддерживается: `import { Client, Config } from '@epptools/sdk';`.

Прежде чем что-то запускать, нужно получить у реестра четыре вещи: ваш **clID**, ваш **пароль**,
**связку CA**, которой подписан серверный сертификат реестра, и внесённый в список разрешённых
IP-адрес отправления для этого clID. Клиентского сертификата на публичной точке подключения нет, и
никакого ключа API тоже: аутентификация — это clID и пароль поверх TLS.

## Программа

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

Запускайте её с паролем в переменной окружения, а не в файле:

```bash
EPP_PASSWORD='your-secret' node register.js
```

## Что делает каждая строка

### Импорты

```js
const {
  Client, Config,
  EppError, CommandError, InsufficientFundsError, ObjectExistsError,
} = require('@epptools/sdk');
```

`Client` — это сессия, `Config` — её неизменяемые настройки. Четыре класса ошибок — те, на которые
эта программа реагирует по-разному; любой сбой, который поднимает библиотека, наследуется от
`EppError`, поэтому последняя ветка действительно перехватывает всё, что приходит отсюда. Полная
иерархия — в [Ошибках](errors.md).

### Создание клиента

```js
const client = new Client(new Config({ ... }));
```

`Config` создаётся один раз и больше не меняется. Поле за полем:

| Поле здесь | Зачем |
|---|---|
| `host`, `port` | точка подключения реестра. 700 — значение по умолчанию, и переопределяют его, только если точка переехала |
| `clid`, `password` | ваши учётные данные. Пароль берётся из окружения, чтобы его не было в репозитории |
| `caFile` | **обязателен для этой точки подключения.** Сертификат на `epp.registry.example:700` выпущен собственным частным CA реестра, которого нет в системном хранилище доверия, поэтому без него рукопожатие не проходит |
| `lang` | язык сообщений реестра о результате: `en`, `uk`, `ua` или `ru` |
| `connectTimeout`, `readTimeout` | **миллисекунды**, минимум 1000. Меньшее значение отклоняется, а не поднимается молча до нижней границы |

Каждое поле, его значение по умолчанию и то, что происходит при неверном значении, — в
[Сессии](session.md#config).

### Подключение

```js
const greeting = await client.connect();
console.log('connected to', greeting.value('svID'));
```

`connect()` открывает TLS-сокет и читает `<greeting>`, которое сервер присылает без запроса. Промис
разрешается этим приветствием как [`Response`](responses.md), поэтому `value('svID')` даёт имя
сервера, а `serviceObjUris()` / `serviceExtUris()` — пространства имён объектов и расширений,
которые он поддерживает. Клиент сохраняет приветствие и входит, объявляя ровно эти сервисы, так что
сессию никогда не отклонят за запрос того, чего сервер не предлагает.

Если эта строка падает с `certificate verify failed`, значит `caFile` не задан или указывает не на
ту связку — как это проверить, показано в [Сессии](session.md#когда-рукопожатие-не-проходит).

### Вход и чтение того, что сервер говорит о сессии

```js
const session = await client.login();
for (const event of session.securityEvents()) { ... }
```

`login()` отправляет `<login>` с вашими clID и паролем и разрешается ответом. Всё, кроме 1000,
отклоняет промис: 2200 — как `AuthError`, а остальные отказы (сервис, которого сервер не предлагает;
язык, которого он не поддерживает; слишком много одновременных сессий) — тем классом, который им
соответствует. У каждого своё лекарство, и если назвать их все ошибкой аутентификации, вы пойдёте
менять пароль, который был ни при чём.

`securityEvents()` — это блок RFC 8807: предупреждения сервера именно об *этой* сессии, например о
клиентском сертификате, которому осталось три недели, или об устаревшем наборе шифров. На здоровой
сессии список пуст, поэтому любую запись в нём считайте поводом что-то сделать. См.
[Сессию](session.md#безопасность-входа-rfc-8807).

### Вопрос, свободно ли имя и сколько оно стоит

```js
const check = await client.domain.check([NAME], { create: 1 });
if (check.isAvailable(NAME) !== true) { ... }
```

`domain.check()` соответствует `<domain:check>` (RFC 5731). Она ничего не меняет и ничего не стоит,
поэтому её безопаснее всего отправлять первой. Второй аргумент — запрос цены по RFC 8748,
*операция => годы*, который узнаёт цену в том же обмене.

Сравнение сделано через `!== true`, а не проверкой на ложность, намеренно: `isAvailable()`
возвращает `true`, `false` или **`null`, когда в ответе об этом имени не сказано ничего вообще**.
«Реестр не ответил» — это не то же самое, что «занято», а следующая строка регистрирует домен.

```js
const price = check.feeFor(NAME, 'create', 1);
```

`feeFor(name, operation, years)` возвращает ровно ту котировку, о которой вы спросили, точной
десятичной строкой, либо `null`, когда в ответе такой котировки не было. `fees()` возвращает всю
таблицу по каждому имени, если нужны ещё и причины, и тарифный класс; `fees()._currency` — валюта, в
которой котировал реестр. Ценам целиком посвящён [Баланс](balance.md).

### Регистрация

```js
const created = await client.domain.createBuilder(NAME)
  .years(1)
  .registrant(REGISTRANT)
  ...
  .maxFee(price)
  .send();
```

Это форма `domain.create(name, opts)` с цепочкой вызовов — та же команда, тот же кадр, тот же
результат. Разница в том, что опечатка в названии шага — это несуществующий метод, о котором вам
скажет редактор, а не ключ, который никто не читает. До вызова `send()` ничего не отправляется, а
билдер отправляет один раз: отправить дважды означало бы две регистрации и два списания. См.
[Билдеры](builders.md).

`.maxFee(price)` — это согласование цены, и оно задаёт **потолок, а не цену, которую назначаете вы**.
Реестр списывает свою цену; если она выше согласованной вами — из-за смены тарифа, премиального
имени, устаревшего кэша, — команда отклоняется с кодом 2004 и **ничего не списывается**, вместо того
чтобы молча выставить вам больше, чем вы показали клиенту. Шаг необязательный: без него команда
уходит как есть, по цене реестра.

### Чтение ответа

```js
console.log('svTRID', created.svTRID());
if (created.isPending()) { ... } else { ... }
```

**Сохраните `svTRID` рядом с доменом.** Это собственный идентификатор операции в реестре и
единственное значение, по которому поддержка может её найти; ваш `clTRID` не значит ничего ни для
кого, кроме вас.

`isPending()` истинно для кода ответа **1001**: команда принята и выполняется офлайн. Это не отказ и
не завершение. Никогда не отправляйте её повторно «на всякий случай» — следите за итогом в
[очереди poll](poll.md) и сопоставляйте его по только что сохранённому `svTRID`.

`expiryDate()` — собственная строка реестра; не разбирайте и не переформатируйте её. `feeAmount()` и
`feeCurrency()` — то, что эта команда действительно списала, отражённое расширением цены, либо
`null`, когда в ответе не было блока цены.

### Баланс

```js
const account = await client.balance();
console.log(`balance ${account.currentBalance()}, available ${account.availableCredit()}`);
```

`client.balance()` — запрос об учётной записи, а не об объекте. Обе величины — точные десятичные
строки; никогда не переводите их в числа перед арифметикой.

### Выход и закрытие сокета

```js
await client.logout();
...
.finally(() => client.disconnect());
```

`logout()` отправляет `<logout>`, сервер отвечает 1500 и закрывает соединение. `disconnect()`
закрывает сокет на вашей стороне, и его безопасно вызывать независимо от того, была ли сессия вообще
открыта, — поэтому он и стоит в `finally()`: исключение где угодно выше не должно оставить сокет
открытым.

### Обработка ошибок

```js
if (err instanceof InsufficientFundsError) { ... }
```

`InsufficientFundsError` (2104) заслуживает отдельной ветки, потому что с самим запросом всё в
порядке: учётной записи нечем платить, и каждая следующая платная команда упадёт так же, пока счёт не
пополнят. В пакетной обработке это тот случай, когда нужно останавливаться, а не пропускать.

`ObjectExistsError` (2302) означает, что имя заняли между check и create — настоящая гонка, а не
ошибка в коде. `err.subject()` — объект, который назвал реестр, и это важно, когда команда несла
несколько.

`CommandError` покрывает все прочие отказы; ветвитесь по `err.eppCode` и читайте `err.reasons()` —
там дополнительный диагностический текст, который приложил реестр. `EppError` ловит всё остальное,
что может поднять библиотека, поэтому ничто не ускользает без типа. В [Ошибках](errors.md) есть вся
таблица целиком и то, что делать, когда изменяющая команда не удалась, а понять, произошла ли она,
невозможно.

## Куда дальше

- [Сессия](session.md) — каждое поле `Config`, TLS и безопасность входа
- [Команды](commands.md) — что возвращает команда, идентификаторы транзакций, произвольные кадры
- [Домены](domains.md) — остальная часть доменной поверхности
- [Ошибки](errors.md) — таксономия сбоев и правило неизвестного исхода

---

[← Оглавление руководства](README.md)
