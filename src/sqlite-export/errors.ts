const SYSTEM_CODES: Record<string,string> = {
  ENOSPC:"недостаточно места на диске", EACCES:"нет прав доступа к файлу", EPERM:"операция с файлом запрещена",
  CURL_NOT_FOUND:"для ограниченного HTTP stream нужен curl", HTTP_STATUS_ERROR:"HTTP endpoint источника отклонил запрос",
  MKFIFO_NOT_FOUND:"для ограниченного HTTP stream нужен mkfifo",
  HTTP_TRANSPORT_ERROR:"HTTP stream соединение прервано",
  ENOENT:"файл или каталог не найден", EEXIST:"файл назначения уже существует",
  ECONNREFUSED:"сервер базы недоступен", ECONNRESET:"соединение с базой прервано", ETIMEDOUT:"тайм-аут соединения",
  SQLITE_FULL:"недостаточно места для SQLite", SQLITE_CONSTRAINT:"нарушена целостность SQLite", SQLITE_BUSY:"SQLite занят",
};

/** Safe message for CLI; the original error remains available to local programmatic callers as cause. */
export class SqliteExportFailure extends Error {
  readonly code: string;
  constructor(readonly operation: string, cause: unknown, counts?: Readonly<Record<string,number>>) {
    let code="UNEXPECTED_ERROR", reason="непредвиденная ошибка";
    const rawCode=cause&&typeof cause==="object"&&"code"in cause&&typeof cause.code==="string"?cause.code:undefined;
    if(cause instanceof SqliteExportFailure){code=cause.code;reason=cause.safeReason;}
    else if(rawCode&&SYSTEM_CODES[rawCode]){code=rawCode;reason=SYSTEM_CODES[rawCode]!;}
    else if(cause instanceof Error){
      if(/timed?\s*out|timeout|time limit/i.test(cause.message)){code="QUERY_TIMEOUT";reason="превышено время выполнения запроса";}
      else if(/memory|allocation/i.test(cause.message)){code="MEMORY_LIMIT";reason="недостаточно памяти для операции";}
      else if(/constraint|UNIQUE|FOREIGN KEY/i.test(cause.message)){code="SQLITE_CONSTRAINT";reason="нарушена целостность SQLite";}
      else if(cause.name==="CallTerminatedError"||cause.name==="ConnectionClosedError"){code="CONNECTION_CLOSED";reason="соединение с SurrealDB закрыто; проверьте состояние сервера";}
      else if(cause.name==="AbortError"){code="CANCELLED";reason="экспорт отменён";}
      else if(cause.name==="QueryError"){code="QUERY_FAILED";reason="сервер отклонил запрос";}
      else if(cause.name==="TypeError"||cause.name==="RangeError"){code=cause.name;reason="неподдержанное значение или форма данных";}
      else if(cause.message.startsWith("sqlite export:")){code="EXPORT_INVARIANT";reason=cause.message.slice("sqlite export:".length).trim();}
    }
    if(rawCode==="HTTP_STATUS_ERROR"&&cause&&typeof cause==="object"&&"status"in cause&&typeof cause.status==="number"&&Number.isInteger(cause.status)&&cause.status>=100&&cause.status<=599)code=`HTTP_${cause.status}`;
    const location=cause instanceof SqliteExportFailure?`${operation}/${cause.operation}`:operation;
    const position=counts?`; ревизий ${counts.read_revisions??0}/${counts.manifest_revisions??0}`:"";
    super(`export:sqlite: ${location}; ${code}: ${reason}${position}`,{cause});
    this.code=code;this.safeReason=reason;
  }
  private readonly safeReason: string;
}
