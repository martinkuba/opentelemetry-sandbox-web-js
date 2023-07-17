

End-user configuration 

```js
const logsAPI = require('@opentelemetry/sandbox-api-logs');
const eventsAPI = require('@opentelemetry/sandbox-api-events');
const {
  LoggerProvider,
  SimpleLogRecordProcessor,
  ConsoleLogRecordExporter,
} = require('@opentelemetry/sandbox-sdk-logs');
const {
  EventEmitterProvider
} = require('@opentelemetry/sandbox-sdk-events');

// configure global LoggerProvider
const loggerProvider = new LoggerProvider();
loggerProvider.addLogRecordProcessor(
  new SimpleLogRecordProcessor(new ConsoleLogRecordExporter())
);
logsAPI.logs.setGlobalLoggerProvider(loggerProvider);

// configure global EventEmitterProvider
const eventEmitterProvider = new EventEmitterProvider();
eventsAPI.setGlobalEventEmitterProvider(eventEmitterProvider);
```

Instrumentation usage

```js
const eventsAPI = require('@opentelemetry/sandbox-api-events');

const eventEmitterProvider = eventsAPI.getEventEmitterProvider();
const eventEmitter = getEventEmitterProvider.getEventEmitter('myEmitter', 'browser');

eventEmitter.emit({
  name: 'myEvent',
  data: {
    field1: 1,
    field2: 'some value'
  },
  attributes: {
    attr1: 1,
    attr2: 'some value'
  }
});
```
