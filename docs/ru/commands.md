# Команды

Всё, что вы отправляете после `<login>`, — это команда, и каждая команда в этой библиотеке ведёт
себя одинаково: собирает один кадр EPP, пишет его, читает ровно один ответ и разрешается объектом
[`Response`](responses.md). Эта страница — про эту форму: что приходит обратно, как опознаются
транзакции, как отключить выбрасывание исключений и как отправить кадр, для которого у библиотеки
нет метода.

Отдельные команды описаны по объектам: [Домены](domains.md),
[Контакты](contacts.md), [Хосты](hosts.md), [Poll](poll.md), [Баланс](balance.md).

## Что возвращает команда

Каждая команда возвращает `Promise<Response>`.

```js
const response = await client.domain.info('example.com.ua');
response.code();        // 1000
response.isSuccess();   // true для любого 1xxx
response.svTRID();      // 'SRV-19700101103512-24191-00007'
```

Промис **разрешается**, когда реестр ответил кодом успеха (1000–1999), и **отклоняется** с
[`CommandError`](errors.md), когда ответ был 2000 или выше. Больше команду не отклоняет ничто —
кроме сбоя транспорта, который приходит как `ConnectionError`, и неверного аргумента, который
приходит как `ValidationError` ещё до отправки.

Коды успеха, которые вам действительно встретятся:

| Код | Значение | Что делать |
|---|---|---|
| `1000` | выполнено | продолжайте; объект в том состоянии, о котором вы просили |
| `1001` | принято, выполняется офлайн | **не отправляйте повторно.** Следите за итогом в [очереди poll](poll.md), сопоставляя по `svTRID` |
| `1300` | poll: очередь пуста | прекращайте опустошать |
| `1301` | poll: ждёт уведомление | прочитайте его, затем подтвердите |
| `1500` | выход принят | сервер закрывает соединение |

Именно на `1001` и спотыкаются. Для него `response.isPending()` истинно. Команда принята и
обрабатывается; это не отказ и не завершённая операция, а повторная отправка «на всякий случай» —
это то, из-за чего домен регистрируется и оплачивается дважды.

Ответ никогда не несёт наполовину разобранный кадр. Усечённый или неправильно сформированный ответ —
это `ConnectionError`, а не `Response`, который случайно читается как успех.

## Поверхность команд

| Метод | Команда EPP |
|---|---|
| **Сессия** — см. [Сессию](session.md) | |
| `Client.connectAndLogin(config)` | подключение + `<login>`, разрешается готовым клиентом |
| `client.connect()` | открывает TLS и читает `<greeting>` |
| `client.hello()` | `<hello>` |
| `client.login(newPassword = null)` | `<login>`, при необходимости со сменой пароля |
| `client.logout()` | `<logout>` |
| `client.disconnect()` | закрывает сокет (кадра нет) |
| `client.isConnected()` / `client.isLoggedIn()` | локальное состояние (кадра нет) |
| `client.throwOnFailure(value = true)` | переключатель, см. ниже (кадра нет) |
| `client.setLogger(logger)` | переключатель, см. [Сессию](session.md#журналирование-с-маскированием-секретов) |
| `client.frame()` / `client.request(frame)` | произвольные кадры, см. ниже |
| `client.balance()` | собственный запрос баланса — [Баланс](balance.md) |
| **Домены** — см. [Домены](domains.md) | |
| `client.domain.check(names, fee = null, currency = null)` | `<domain:check>` (RFC 5731) с необязательным запросом цены по RFC 8748 |
| `client.domain.info(name, authInfo = null, hosts = 'all')` | `<domain:info>` |
| `client.domain.create(name, opts = {})` | `<domain:create>` |
| `client.domain.createBuilder(name)` | то же самое, [шаг за шагом](builders.md) |
| `client.domain.update(name, opts = {})` | `<domain:update>` |
| `client.domain.updateBuilder(name)` | то же самое, [шаг за шагом](builders.md) |
| `client.domain.renew(name, curExpDate, years = 1, fee = null)` | `<domain:renew>` |
| `client.domain.restore(name, fee = null)` | `<domain:update>` с `<rgp:restore op="request">` (RFC 3915) |
| `client.domain.transfer(op, name, authInfo = null, years = null, fee = null)` | `<domain:transfer>` |
| `client.domain.delete(name)` | `<domain:delete>` |
| **Контакты** — см. [Контакты](contacts.md) | |
| `client.contact.check(ids)` | `<contact:check>` (RFC 5733) |
| `client.contact.info(id, authInfo = null)` | `<contact:info>` |
| `client.contact.create(id, opts = {})` | `<contact:create>` |
| `client.contact.createAuto(opts = {})` | `<contact:create>` с `Contact.AUTO_ID`: идентификатор выдаёт реестр |
| `client.contact.createBuilder(id, email)` | то же самое, [шаг за шагом](builders.md) |
| `client.contact.update(id, opts = {})` | `<contact:update>` |
| `client.contact.updateBuilder(id)` | то же самое, [шаг за шагом](builders.md) |
| `client.contact.delete(id)` | `<contact:delete>` |
| `client.contact.transfer(op, id, authInfo = null)` | `<contact:transfer>` |
| **Хосты** — см. [Хосты](hosts.md) | |
| `client.host.check(names)` | `<host:check>` (RFC 5732) |
| `client.host.info(name)` | `<host:info>` |
| `client.host.create(name, addresses = [])` | `<host:create>` |
| `client.host.update(name, opts = {})` | `<host:update>` |
| `client.host.updateBuilder(name)` | то же самое, [шаг за шагом](builders.md) |
| `client.host.delete(name, force = false)` | `<host:delete>`, при необходимости с предварительным отсоединением |
| **Poll** — см. [Poll](poll.md) | |
| `client.poll.request()` | `<poll op="req">` |
| `client.poll.ack(messageId)` | `<poll op="ack">` — **уничтожает уведомление в реестре** |
| `client.poll.drain(handler, limit = 0)` | запрос/обработка/подтверждение в том порядке, при котором уведомление не теряется |

Четыре обработчика ресурсов — `client.domain`, `client.contact`, `client.host`, `client.poll` —
создаются при первом обращении и переиспользуются, поэтому хранить ссылку на любой из них — то же
самое, что каждый раз обращаться через клиента.

## Клиентские идентификаторы транзакций

Каждая команда несёт `clTRID`, который принадлежит **вам**, а каждый ответ — `svTRID`, который
принадлежит **реестру**.

```js
const r = await client.domain.info('example.com.ua');
r.clTRID();   // 'NODEJS-SDK-20260816103012-24191-0003'  — возвращён из вашей команды
r.svTRID();   // 'SRV-19700101103512-24191-00007'     — собственная запись реестра
```

Библиотека генерирует `clTRID` за вас и гарантирует его уникальность для каждой команды. Его вид:

```
<clTRIDPrefix>-<UTC timestamp>-<process id>-<counter>
```

— так что идентификаторы одного процесса имеют общий устойчивый средний сегмент, идентификаторы
параллельных процессов не могут столкнуться, а всё вместе сортируется в журнале хронологически.
Задайте `clTRIDPrefix` в [Config](session.md#config) так, чтобы он опознавал вашу интеграцию; по
умолчанию это `NODEJS-SDK`.

**Сохраняйте `svTRID` рядом с объектом, которого касалась команда.** Это значение, по которому
поддержка находит операцию; `clTRID` не значит ничего ни для кого, кроме вас. Записывайте оба, на
каждой команде, включая удавшиеся: именно с удавшимися вы сравниваете, когда более поздняя не
удаётся.

### Ответ сверяется с командой

Прежде чем ответ будет отдан вам, возвращённый в нём `clTRID` сверяется с отправленным. Если они не
совпадают, соединение **закрывается** и поднимается `ConnectionError`:

```
ConnectionError: Response does not belong to this command (sent clTRID …, received …)
  — the connection was desynchronised and has been closed.
```

Это стоит понять, а не обойти. Без сверки ответ на предыдущую команду не отличить от ответа на
текущую: `renew('example2.com.ua')` возвращает 1000 с датой окончания домена `example1.com.ua`, списываются оба, а
ваши записи врут об обоих. А как только сдвиг возник, подозрительны и все последующие кадры в этом
потоке — потому и закрывается соединение, а не только команда.

Отсюда практическое правило: **отправляйте по одной команде за раз.** Дожидайтесь каждого ответа,
прежде чем писать следующий кадр. Если нужна пропускная способность, открывайте больше сессий, а не
накладывайте команды внутри одной, — и сначала проверьте ограничение реестра на число сессий.

## `throwOnFailure`

По умолчанию код ответа 2000 и выше отклоняет промис самым конкретным
[классом ошибки](errors.md) для этого кода. Отключите это, чтобы читать коды самостоятельно:

```js
client.throwOnFailure(false);

const r = await client.domain.create('example.com.ua', { years: 1, registrant: 'C1' });
if (!r.isSuccess()) {
  console.error(r.code(), r.message(), r.errorReasons());
}
```

Метод возвращает клиента, поэтому вызовы связываются в цепочку, а `throwOnFailure(true)` возвращает
прежнее поведение. Три вещи, которые нужно знать, прежде чем им пользоваться:

- Это переключатель **на весь клиент**, а не на команду. Код в других местах вашего процесса,
  который пользуется тем же клиентом, тоже перестанет выбрасывать исключения.
- `login()` всё равно отклоняет промис на результате, отличном от 1000. Сессию, которая не
  открылась, разглядывать бессмысленно.
- `poll.drain()` всё равно отклоняет промис на ответе, в котором нет ни уведомления, ни пустой
  очереди: вывод «очередь опустошена» из отказа означал бы отчёт об успехе там, где ничего не
  прочитано.

С отключёнными исключениями ничто не заставляет вас смотреть на код ответа. В этом и размен:
проигнорированный `response.code()` — это сбой, которого ваша программа никогда не заметит, а
необработанное отклонение промиса — сбой, мимо которого она пройти не может.

## Опции проверяются до того, как что-либо будет отправлено

Команды, принимающие объект опций, принимают только те ключи, которые задокументированы. Неизвестный
ключ отклоняется с `ValidationError`, который называет ближайший известный:

```js
await client.domain.create('example.com.ua', { years: 1, secdns: { … } });
// ValidationError: domain:create does not accept 'secdns' (did you mean 'secDNS'?).
//                  Accepted: authInfo, contacts, fee, license, nameServers, nameservers,
//                  registrant, secDNS, years.
```

Альтернатива — проигнорировать ключ, а проигнорированный ключ молчит самым скверным образом: команда
всё равно уходит, реестр всё равно отвечает 1000, а того, о чём вы просили, в ней нет. `secdns`
вместо `secDNS` зарегистрирует домен **без подписи**; опечатка в `nameservers` зарегистрирует его
**без делегирования**. В ответе об этом не будет ни слова, потому что с точки зрения реестра вы ни о
чём и не просили. [Билдеры](builders.md) убирают такую возможность совсем: опечатка в названии шага
— это несуществующий метод.

## Произвольные кадры

Всё, чего не покрывает высокоуровневый API, можно собрать через `Frame` и отправить через
`client.request()`.

```js
const { Namespaces } = require('@epptools/sdk');

const frame = client.frame();                       // <command> со сгенерированным clTRID
const check = frame.ns(frame.verb('check'), Namespaces.DOMAIN, 'domain:check');
frame.ns(check, Namespaces.DOMAIN, 'domain:name', 'example.com.ua');

const response = await client.request(frame);       // или client.request(rawXmlString)
console.log(response.availability());
```

Пользуйтесь `client.frame()`, а не `Frame.command(...)`, если нет причин поступить иначе: он
проставляет сгенерированный `clTRID`, а именно это позволяет сопоставить ответ с командой. Если вы
задаёте свой, протокол допускает от 3 до 64 символов, и реестр может вернуть его приведённым к этому
диапазону.

### API `Frame`

| Метод | Что делает |
|---|---|
| `Frame.command(clTRID)` | начинает кадр `<command>` с этим идентификатором транзакции |
| `frame.verb(name)` | добавляет глагол команды — `check`, `info`, `create`, `update`, `renew`, `transfer`, `delete`, `poll`, `login`, `logout` — и возвращает его |
| `frame.extension()` | возвращает элемент `<extension>`, создавая его один раз при первом обращении |
| `frame.epp(parent, name, text = null, attrs = {})` | добавляет дочерний элемент в базовом пространстве имён `epp-1.0` |
| `frame.ns(parent, nsUri, qname, text = null, attrs = {})` | добавляет дочерний элемент с пространством имён, например `('domain:name', …)` в доменном пространстве имён |
| `frame.toXml()` | сериализует кадр |

И `epp()`, и `ns()` возвращают добавленный элемент, поэтому вложенность строится передачей его же
следующим родителем. Атрибуты глагола задаются напрямую:

```js
const transfer = frame.verb('transfer');
transfer.attrs.op = 'request';
```

Кадр гарантирует порядок дочерних элементов по RFC 5730 — содержимое команды, затем необязательный
`<extension>`, затем `<clTRID>` последним — и экранирует каждое сериализуемое значение, так что
ничем переданным вами XML не сломать. `toXml()` безопасно вызывать не один раз: сериализация кадра
для журнала с последующей отправкой не оставит двух элементов `<clTRID>`, которые были бы невалидны
по схеме и заработали бы голый 2001.

Учтите: кадр, который вы сериализуете сами, **не** маскируется. Если вы записываете вывод `toXml()`
в журнал, вычеркните `<pw>`, `<newPW>` и `<authInfo>` до того, как он попадёт на диск.

### Пространства имён

`Namespaces` экспортирует константы протокола, чтобы вам никогда не приходилось набирать URI:

| Константа | URI | Для чего |
|---|---|---|
| `Namespaces.EPP` | `urn:ietf:params:xml:ns:epp-1.0` | базовый протокол (RFC 5730) |
| `Namespaces.DOMAIN` | `urn:ietf:params:xml:ns:domain-1.0` | домены (RFC 5731) |
| `Namespaces.HOST` | `urn:ietf:params:xml:ns:host-1.0` | хосты (RFC 5732) |
| `Namespaces.CONTACT` | `urn:ietf:params:xml:ns:contact-1.0` | контакты (RFC 5733) |
| `Namespaces.SECDNS` | `urn:ietf:params:xml:ns:secDNS-1.1` | DNSSEC (RFC 5910) |
| `Namespaces.RGP` | `urn:ietf:params:xml:ns:rgp-1.0` | выкуп и восстановление (RFC 3915) |
| `Namespaces.FEE` | `urn:ietf:params:xml:ns:epp:fee-1.0` | цены и согласование цены (RFC 8748) |
| `Namespaces.LOGINSEC` | `urn:ietf:params:xml:ns:epp:loginSec-1.0` | безопасность входа (RFC 8807) |
| `Namespaces.XSI` | `http://www.w3.org/2001/XMLSchema-instance` | атрибуты schema-instance |
| `Namespaces.LOGINSEC_SENTINEL` | `[LOGIN-SECURITY]` | зарезервированное значение `<pw>`, означающее «настоящий пароль — в `<loginSec:pw>`» |
| `Namespaces.DEFAULT_OBJ_URIS` | | объектные сервисы, объявляемые, когда приветствие не перечислило ни одного |
| `Namespaces.DEFAULT_EXT_URIS` | | сервисы расширений, объявляемые, когда приветствие не перечислило ни одного |

Ответ читается по **локальному имени элемента и URI пространства имён**, никогда по префиксу,
поэтому произвольный кадр, собранный вами с другими префиксами, всё равно читается обычными
аксессорами [`Response`](responses.md) — включая `value()`, `values()` и `resData()` для всего, для
чего у библиотеки нет именованного аксессора.

### Собственные расширения вашего реестра

Каждый URI выше определён каким-нибудь RFC и одинаков у любого реестра в мире. СОБСТВЕННЫЕ
расширения реестра — лицензия на торговую марку, цена, баланс учётной записи — нет, и константы для
них здесь не будет: нет значения, которое было бы верным больше чем для одного реестра.

Они **определяются из `<greeting>`**. Любой сервер перечисляет то, что поддерживает, ещё до того как
вы что-то отправите, поэтому сразу после `connect()` клиент уже знает:

```js
await client.connect();

client.registryExtUri();      // например 'http://registry.example/epp/registry-1.0', либо null
client.registryBalanceUri();  // например 'http://registry.example/epp/balance-1.0', либо null
```

`null` означает, что этот сервер такого расширения не объявляет, — это факт о сервере, а не ошибка.
Команды, которым расширение необходимо, об этом говорят, а не догадываются: `domain.create` с
`license`, `host.delete` с `force` и `balance()` бросают `ConfigError`, называя, что именно
понадобилось, и перечисляя, что сервер предложил. В этом отказе и есть смысл. Расширение, отправленное
в пространстве имён, которого сервер не знает, **игнорируется, а не отвергается**, — то есть догадка
вернулась бы как `1000 OK` с молча не установленной лицензией.

Определение сопоставляет последний сегмент объявленного URI — `.../registry-1.0`, `urn:…:balance`, —
и это соглашение, которому реестры следуют, а не правило, которое кто-то принуждает соблюдать. Если
реестр называет свои расширения иначе, задайте их сами — тогда приветствие не спрашивается:

```js
const config = new Config({
  host: 'epp.registry.example', clid: 'EXAMPLE', password: '...',
  registryExtUri: 'urn:example:params:xml:ns:myreg-1.0',
  registryBalanceUri: 'urn:example:params:xml:ns:myreg-balance-1.0',
});
```

### Коды ответа по имени

У `ResultCode` есть именованная константа для каждого кода из RFC 5730, чтобы ветвиться без голых
чисел:

```js
const { ResultCode } = require('@epptools/sdk');

if (response.code() === ResultCode.SUCCESS_PENDING) { /* 1001 */ }
if (err.eppCode === ResultCode.OBJECT_EXISTS) { /* 2302 */ }
```

Полный список и то, что каждый код означает для вашего следующего шага, — в
[Ошибках](errors.md#коды-ответа).

---

[← Оглавление руководства](README.md)
