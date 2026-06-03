import * as snowflake from 'snowflake-sdk';
import {
  ConnectionProfile,
  ConnectionSecrets,
  DbAdapter,
  ForeignKeyModel,
  NonQueryResult,
  QueryResult,
  QueryRunOptions,
  RoutineModel,
  SchemaIntrospection,
  SchemaModel,
  TableModel
} from './types';

const CONNECTION_TIMEOUT_MS = 30000;
const SNOWFLAKE_DOMAIN_SUFFIX = '.snowflakecomputing.com';

interface SnowflakeSchemaEntry {
  name: string;
  tables: Map<string, TableModel>;
  views: Map<string, TableModel>;
  procedures: RoutineModel[];
  functions: RoutineModel[];
}

export class SnowflakeAdapter implements DbAdapter {
  readonly dialect = 'snowflake';

  async testConnection(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<void> {
    const conn = this.createConnection(profile, secrets);
    try {
      await this.connect(conn);
      await this.execute(conn, 'SELECT 1');
    } finally {
      await this.destroy(conn);
    }
  }

  async runQuery(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    sql: string,
    _options: QueryRunOptions
  ): Promise<QueryResult> {
    const conn = this.createConnection(profile, secrets);
    const start = Date.now();

    try {
      await this.connect(conn);
      const { rows, statement } = await this.executeWithStatement(conn, sql);
      const elapsedMs = Date.now() - start;

      const cols = statement.getColumns() ?? [];
      const columns = cols.map((c: any) => ({
        name: c.getName(),
        type: c.getType(),
        normalizedType: c.getType()
      }));

      return {
        columns,
        rows,
        rowCount: rows.length,
        elapsedMs
      };
    } finally {
      await this.destroy(conn);
    }
  }

  async executeNonQuery(
    profile: ConnectionProfile,
    secrets: ConnectionSecrets,
    sql: string
  ): Promise<NonQueryResult> {
    const conn = this.createConnection(profile, secrets);
    try {
      await this.connect(conn);
      const { rows, statement } = await this.executeWithStatement(conn, sql);
      const numRows = statement.getNumRows?.() ?? rows.length;
      return { affectedRows: numRows };
    } finally {
      await this.destroy(conn);
    }
  }

  async introspectSchema(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<SchemaIntrospection> {
    const conn = this.createConnection(profile, secrets);
    try {
      await this.connect(conn);

      const targetDatabase = await this.getCurrentDatabase(conn);
      if (!targetDatabase) {
        throw new Error(
          'No Snowflake database could be resolved for this connection. ' +
          'Ensure the database exists and your role has USAGE privilege on it.'
        );
      }

      const targetSchema = profile.schema?.trim()
        ? await this.getCurrentSchema(conn) ?? profile.schema.trim()
        : undefined;
      const [schemaRows, tableRows, columnRows, primaryKeyRows, foreignKeyRows] = await Promise.all([
        this.execute(conn, this.buildSchemasIntrospectionSql(targetDatabase, targetSchema)),
        this.execute(conn, this.buildTablesIntrospectionSql(targetDatabase, targetSchema)),
        this.execute(conn, this.buildColumnsIntrospectionSql(targetDatabase, targetSchema)),
        this.execute(conn, this.buildPrimaryKeysIntrospectionSql(targetDatabase, targetSchema)),
        this.execute(conn, this.buildForeignKeysIntrospectionSql(targetDatabase, targetSchema))
      ]);
      const routineRows = await this.executeOptional(conn, this.buildRoutinesIntrospectionSql(targetDatabase, targetSchema));

      const schemasMap = new Map<string, SnowflakeSchemaEntry>();
      const tableTypeMap = new Map<string, string>();
      const tableCommentMap = new Map<string, string | undefined>();

      for (const row of schemaRows) {
        const schemaName = this.getRowString(row, ['SCHEMA_NAME', 'schema_name']);
        if (schemaName) {
          this.ensureSchema(schemasMap, schemaName);
        }
      }

      for (const row of tableRows) {
        const schemaName = this.getRowString(row, ['TABLE_SCHEMA', 'table_schema']);
        const tableName = this.getRowString(row, ['TABLE_NAME', 'table_name']);
        const tableType = this.getRowString(row, ['TABLE_TYPE', 'table_type']) || 'BASE TABLE';
        const tableComment = this.getRowString(row, ['COMMENT', 'comment']);
        if (!schemaName || !tableName) {
          continue;
        }

        const tableKey = this.objectKey(schemaName, tableName);
        tableTypeMap.set(tableKey, tableType);
        tableCommentMap.set(tableKey, tableComment);

        const schema = this.ensureSchema(schemasMap, schemaName);
        const targetMap = this.isViewType(tableType) ? schema.views : schema.tables;
        if (!targetMap.has(tableName)) {
          targetMap.set(tableName, {
            name: tableName,
            comment: tableComment || undefined,
            columns: [],
            foreignKeys: []
          });
        }
      }

      for (const row of columnRows) {
        const schemaName = this.getRowString(row, ['TABLE_SCHEMA', 'table_schema']);
        const tableName = this.getRowString(row, ['TABLE_NAME', 'table_name']);
        const columnName = this.getRowString(row, ['COLUMN_NAME', 'column_name']);
        const dataType = this.getRowString(row, ['DATA_TYPE', 'data_type']) || 'UNKNOWN';
        const nullableRaw = this.getRowString(row, ['IS_NULLABLE', 'is_nullable']) || '';
        const columnComment = this.getRowString(row, ['COMMENT', 'comment']);

        if (!schemaName || !tableName || !columnName) {
          continue;
        }

        const schema = this.ensureSchema(schemasMap, schemaName);
        const tableKey = this.objectKey(schemaName, tableName);
        const tableType = tableTypeMap.get(tableKey) || 'BASE TABLE';
        const targetMap = this.isViewType(tableType) ? schema.views : schema.tables;

        if (!targetMap.has(tableName)) {
          targetMap.set(tableName, {
            name: tableName,
            comment: tableCommentMap.get(tableKey),
            columns: [],
            foreignKeys: []
          });
        }
        const table = targetMap.get(tableName)!;

        table.columns.push({
          name: columnName,
          type: dataType,
          nullable: nullableRaw.toUpperCase() === 'YES',
          comment: columnComment || undefined
        });
      }

      for (const row of primaryKeyRows) {
        const schemaName = this.getRowString(row, ['TABLE_SCHEMA', 'table_schema']);
        const tableName = this.getRowString(row, ['TABLE_NAME', 'table_name']);
        const columnName = this.getRowString(row, ['COLUMN_NAME', 'column_name']);
        if (!schemaName || !tableName || !columnName) {
          continue;
        }

        const table = schemasMap.get(schemaName)?.tables.get(tableName);
        if (!table) {
          continue;
        }
        table.primaryKey = table.primaryKey ?? [];
        table.primaryKey.push(columnName);
      }

      for (const row of foreignKeyRows) {
        const schemaName = this.getRowString(row, ['TABLE_SCHEMA', 'table_schema']);
        const tableName = this.getRowString(row, ['TABLE_NAME', 'table_name']);
        const columnName = this.getRowString(row, ['COLUMN_NAME', 'column_name']);
        const foreignSchema = this.getRowString(row, ['FOREIGN_SCHEMA', 'foreign_schema']);
        const foreignTable = this.getRowString(row, ['FOREIGN_TABLE', 'foreign_table']);
        const foreignColumn = this.getRowString(row, ['FOREIGN_COLUMN', 'foreign_column']);
        if (!schemaName || !tableName || !columnName || !foreignSchema || !foreignTable || !foreignColumn) {
          continue;
        }

        const table = schemasMap.get(schemaName)?.tables.get(tableName);
        if (!table) {
          continue;
        }

        const foreignKey: ForeignKeyModel = {
          name: this.getRowString(row, ['CONSTRAINT_NAME', 'constraint_name']),
          column: columnName,
          foreignSchema,
          foreignTable,
          foreignColumn
        };
        table.foreignKeys = table.foreignKeys ?? [];
        table.foreignKeys.push(foreignKey);
      }

      for (const row of routineRows) {
        const schemaName = this.getRowString(row, ['ROUTINE_SCHEMA', 'routine_schema']);
        const routineName = this.getRowString(row, ['ROUTINE_NAME', 'routine_name']);
        const routineTypeRaw = this.getRowString(row, ['ROUTINE_TYPE', 'routine_type']) ?? '';
        const returnType = this.getRowString(row, ['DATA_TYPE', 'data_type']);
        const argumentSignature = this.getRowString(row, ['ARGUMENT_SIGNATURE', 'argument_signature']);
        const language = this.getRowString(row, ['ROUTINE_LANGUAGE', 'routine_language']);
        const comment = this.getRowString(row, ['COMMENT', 'comment']);

        if (!schemaName || !routineName) {
          continue;
        }

        const schema = this.ensureSchema(schemasMap, schemaName);

        const kind = routineTypeRaw.toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function';
        const routine: RoutineModel = {
          name: routineName,
          kind,
          returnType: kind === 'function' ? returnType || undefined : undefined,
          language: language || undefined,
          comment: comment || undefined,
          signature: this.buildRoutineSignatureFromArgumentSignature(routineName, argumentSignature),
          parameters: this.parseRoutineParameters(argumentSignature)
        };

        if (kind === 'procedure') {
          schema.procedures.push(routine);
        } else {
          schema.functions.push(routine);
        }
      }

      for (const schema of schemasMap.values()) {
        const sortRoutine = (a: RoutineModel, b: RoutineModel): number =>
          a.name.localeCompare(b.name) || (a.signature || '').localeCompare(b.signature || '');

        for (const routine of [...schema.procedures, ...schema.functions]) {
          if (routine.parameters && routine.parameters.length > 0) {
            routine.parameters.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
          }
          routine.signature = this.buildRoutineSignature(routine);
        }

        schema.procedures.sort(sortRoutine);
        schema.functions.sort(sortRoutine);
      }

      const schemas: SchemaModel[] = Array.from(schemasMap.values())
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((schema) => ({
          name: schema.name,
          tables: Array.from(schema.tables.values()).sort((a, b) => a.name.localeCompare(b.name)),
          views: Array.from(schema.views.values()).sort((a, b) => a.name.localeCompare(b.name)),
          procedures: schema.procedures,
          functions: schema.functions
        }));

      return {
        version: '0.2',
        generatedAt: new Date().toISOString(),
        connectionId: profile.id,
        connectionName: profile.name,
        dialect: 'snowflake',
        schemas
      };
    } finally {
      await this.destroy(conn);
    }
  }

  private async getCurrentDatabase(conn: snowflake.Connection): Promise<string | undefined> {
    try {
      const rows = await this.execute(conn, 'SELECT CURRENT_DATABASE() AS CURRENT_DATABASE');
      if (!rows || rows.length === 0) {
        return undefined;
      }
      return this.getRowString(rows[0], ['CURRENT_DATABASE', 'current_database']);
    } catch {
      return undefined;
    }
  }

  private async getCurrentSchema(conn: snowflake.Connection): Promise<string | undefined> {
    try {
      const rows = await this.execute(conn, 'SELECT CURRENT_SCHEMA() AS CURRENT_SCHEMA');
      if (!rows || rows.length === 0) {
        return undefined;
      }
      return this.getRowString(rows[0], ['CURRENT_SCHEMA', 'current_schema']);
    } catch {
      return undefined;
    }
  }

  private buildSchemasIntrospectionSql(databaseName: string, schemaName?: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT SCHEMA_NAME
      FROM ${db}.INFORMATION_SCHEMA.SCHEMATA
      WHERE SCHEMA_NAME NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ${this.buildSchemaFilter('SCHEMA_NAME', schemaName)}
      ORDER BY SCHEMA_NAME
    `;
  }

  private buildTablesIntrospectionSql(databaseName: string, schemaName?: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT
        TABLE_SCHEMA,
        TABLE_NAME,
        TABLE_TYPE,
        COMMENT
      FROM ${db}.INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ${this.buildSchemaFilter('TABLE_SCHEMA', schemaName)}
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `;
  }

  private buildColumnsIntrospectionSql(databaseName: string, schemaName?: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT
        TABLE_CATALOG,
        TABLE_SCHEMA,
        TABLE_NAME,
        COLUMN_NAME,
        DATA_TYPE,
        IS_NULLABLE,
        COMMENT
      FROM ${db}.INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ${this.buildSchemaFilter('TABLE_SCHEMA', schemaName)}
      ORDER BY TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
    `;
  }

  private buildPrimaryKeysIntrospectionSql(databaseName: string, schemaName?: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT
        kcu.TABLE_SCHEMA,
        kcu.TABLE_NAME,
        kcu.COLUMN_NAME
      FROM ${db}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN ${db}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        ON kcu.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
       AND kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
        AND kcu.TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
        ${this.buildSchemaFilter('kcu.TABLE_SCHEMA', schemaName)}
      ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION
    `;
  }

  private buildForeignKeysIntrospectionSql(databaseName: string, schemaName?: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT
        fk.TABLE_SCHEMA,
        fk.TABLE_NAME,
        fk.COLUMN_NAME,
        tc.CONSTRAINT_NAME,
        pk.TABLE_SCHEMA AS FOREIGN_SCHEMA,
        pk.TABLE_NAME AS FOREIGN_TABLE,
        pk.COLUMN_NAME AS FOREIGN_COLUMN
      FROM ${db}.INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
      JOIN ${db}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE fk
        ON fk.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
       AND fk.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND fk.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      JOIN ${db}.INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
        ON rc.CONSTRAINT_CATALOG = tc.CONSTRAINT_CATALOG
       AND rc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
       AND rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      JOIN ${db}.INFORMATION_SCHEMA.KEY_COLUMN_USAGE pk
        ON pk.CONSTRAINT_CATALOG = rc.UNIQUE_CONSTRAINT_CATALOG
       AND pk.CONSTRAINT_SCHEMA = rc.UNIQUE_CONSTRAINT_SCHEMA
       AND pk.CONSTRAINT_NAME = rc.UNIQUE_CONSTRAINT_NAME
       AND pk.ORDINAL_POSITION = fk.POSITION_IN_UNIQUE_CONSTRAINT
      WHERE tc.CONSTRAINT_TYPE = 'FOREIGN KEY'
        AND fk.TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
        ${this.buildSchemaFilter('fk.TABLE_SCHEMA', schemaName)}
      ORDER BY fk.TABLE_SCHEMA, fk.TABLE_NAME, tc.CONSTRAINT_NAME, fk.ORDINAL_POSITION
    `;
  }

  private buildRoutinesIntrospectionSql(databaseName: string, schemaName?: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT
        PROCEDURE_SCHEMA AS ROUTINE_SCHEMA,
        PROCEDURE_NAME AS ROUTINE_NAME,
        'PROCEDURE' AS ROUTINE_TYPE,
        DATA_TYPE,
        ARGUMENT_SIGNATURE,
        PROCEDURE_LANGUAGE AS ROUTINE_LANGUAGE,
        COMMENT
      FROM ${db}.INFORMATION_SCHEMA.PROCEDURES
      WHERE PROCEDURE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ${this.buildSchemaFilter('PROCEDURE_SCHEMA', schemaName)}
      UNION ALL
      SELECT
        FUNCTION_SCHEMA AS ROUTINE_SCHEMA,
        FUNCTION_NAME AS ROUTINE_NAME,
        'FUNCTION' AS ROUTINE_TYPE,
        DATA_TYPE,
        ARGUMENT_SIGNATURE,
        FUNCTION_LANGUAGE AS ROUTINE_LANGUAGE,
        COMMENT
      FROM ${db}.INFORMATION_SCHEMA.FUNCTIONS
      WHERE FUNCTION_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ${this.buildSchemaFilter('FUNCTION_SCHEMA', schemaName)}
      ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME, ARGUMENT_SIGNATURE
    `;
  }

  private ensureSchema(schemasMap: Map<string, SnowflakeSchemaEntry>, name: string): SnowflakeSchemaEntry {
    if (!schemasMap.has(name)) {
      schemasMap.set(name, {
        name,
        tables: new Map(),
        views: new Map(),
        procedures: [],
        functions: []
      });
    }
    return schemasMap.get(name)!;
  }

  private objectKey(schemaName: string, objectName: string): string {
    return `${schemaName}\u0000${objectName}`;
  }

  private isViewType(tableType: string): boolean {
    return tableType.toUpperCase().includes('VIEW');
  }

  private quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`;
  }

  private quoteStringLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  private buildSchemaFilter(columnName: string, schemaName: string | undefined): string {
    return schemaName ? `AND ${columnName} = ${this.quoteStringLiteral(schemaName)}` : '';
  }

  private getRowString(row: Record<string, unknown>, keys: string[]): string | undefined {
    if (!row) {
      return undefined;
    }

    for (const key of keys) {
      const direct = row[key];
      if (typeof direct === 'string' && direct.trim() !== '') {
        return direct.trim();
      }
    }

    const lowerKeys = new Set(keys.map((k) => k.toLowerCase()));
    for (const [key, value] of Object.entries(row)) {
      if (!lowerKeys.has(key.toLowerCase())) {
        continue;
      }
      if (typeof value === 'string' && value.trim() !== '') {
        return value.trim();
      }
      if (value !== undefined && value !== null) {
        return String(value);
      }
    }

    return undefined;
  }

  private buildRoutineSignature(routine: RoutineModel): string {
    const parameters = routine.parameters ?? [];
    if (parameters.length === 0 && routine.signature) {
      return routine.signature;
    }

    const args = parameters
      .filter((parameter) => parameter.mode !== 'return')
      .map((parameter) => {
        const modePrefix = parameter.mode ? `${parameter.mode.toUpperCase()} ` : '';
        const typeSuffix = parameter.type ? ` ${parameter.type}` : '';
        return `${modePrefix}${parameter.name}${typeSuffix}`.trim();
      })
      .join(', ');
    return `${routine.name}(${args})`;
  }

  private buildRoutineSignatureFromArgumentSignature(routineName: string, argumentSignature: string | undefined): string {
    const signature = argumentSignature?.trim();
    if (!signature) {
      return `${routineName}()`;
    }

    return signature.startsWith('(') ? `${routineName}${signature}` : `${routineName}(${signature})`;
  }

  private parseRoutineParameters(argumentSignature: string | undefined): NonNullable<RoutineModel['parameters']> {
    const signature = argumentSignature?.trim();
    if (!signature) {
      return [];
    }

    const body = signature.startsWith('(') && signature.endsWith(')')
      ? signature.slice(1, -1).trim()
      : signature;
    if (!body) {
      return [];
    }

    return this.splitTopLevelArguments(body).map((argument, index) => {
      const parts = argument.trim().split(/\s+/);
      const hasExplicitName = parts.length > 1 && !this.looksLikeSnowflakeType(parts[0]);
      const name = hasExplicitName ? parts[0] : `arg${index + 1}`;
      const type = hasExplicitName ? parts.slice(1).join(' ') : argument.trim();

      return {
        name,
        mode: 'in',
        type: type || undefined,
        position: index + 1
      };
    });
  }

  private splitTopLevelArguments(args: string): string[] {
    const result: string[] = [];
    let current = '';
    let depth = 0;

    for (const char of args) {
      if (char === '(') {
        depth += 1;
      } else if (char === ')' && depth > 0) {
        depth -= 1;
      }

      if (char === ',' && depth === 0) {
        const value = current.trim();
        if (value) {
          result.push(value);
        }
        current = '';
        continue;
      }

      current += char;
    }

    const value = current.trim();
    if (value) {
      result.push(value);
    }

    return result;
  }

  private looksLikeSnowflakeType(value: string): boolean {
    const normalized = value.replace(/\(.*/, '').toUpperCase();
    return [
      'ARRAY',
      'BIGINT',
      'BINARY',
      'BOOLEAN',
      'CHAR',
      'CHARACTER',
      'DATE',
      'DATETIME',
      'DEC',
      'DECIMAL',
      'DOUBLE',
      'FLOAT',
      'GEOGRAPHY',
      'GEOMETRY',
      'INT',
      'INTEGER',
      'NUMBER',
      'NUMERIC',
      'OBJECT',
      'REAL',
      'STRING',
      'TEXT',
      'TIME',
      'TIMESTAMP',
      'TIMESTAMP_LTZ',
      'TIMESTAMP_NTZ',
      'TIMESTAMP_TZ',
      'VARIANT',
      'VARCHAR'
    ].includes(normalized);
  }

  private createConnection(profile: ConnectionProfile, secrets: ConnectionSecrets): snowflake.Connection {
    const options: snowflake.ConnectionOptions = {
      account: this.normalizeAccountForSdk(profile.account),
      username: profile.username!,
      warehouse: profile.warehouse,
      database: profile.database,
      schema: profile.schema,
      role: profile.role || undefined,
      clientSessionKeepAlive: true
    };

    if (profile.authMode === 'keypair') {
      options.authenticator = 'SNOWFLAKE_JWT';
      options.privateKeyPath = profile.privateKeyPath;
      if (secrets.privateKeyPassphrase) {
        options.privateKeyPass = String(secrets.privateKeyPassphrase);
      }
    } else {
      options.password = secrets.password as string;
    }

    return snowflake.createConnection(options);
  }

  private normalizeAccountForSdk(account: string | undefined): string {
    const raw = String(account ?? '').trim();
    if (!raw) {
      return raw;
    }

    const host = raw
      .replace(/^jdbc:snowflake:\/\//i, '')
      .replace(/^https?:\/\//i, '')
      .split(/[/?#]/)[0]
      .replace(/\.$/, '');

    if (host.toLowerCase().endsWith(SNOWFLAKE_DOMAIN_SUFFIX)) {
      return host.slice(0, -SNOWFLAKE_DOMAIN_SUFFIX.length);
    }

    return host;
  }

  private connect(conn: snowflake.Connection): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timed out after ${CONNECTION_TIMEOUT_MS / 1000} seconds`));
      }, CONNECTION_TIMEOUT_MS);

      conn.connect((err: Error | undefined) => {
        clearTimeout(timeout);
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private destroy(conn: snowflake.Connection): Promise<void> {
    return new Promise((resolve) => {
      conn.destroy(() => resolve());
    });
  }

  private execute(conn: snowflake.Connection, sql: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        complete: (err: Error | undefined, _stmt: snowflake.RowStatement, rows: any[] | undefined) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      });
    });
  }

  private async executeOptional(conn: snowflake.Connection, sql: string): Promise<any[]> {
    try {
      return await this.execute(conn, sql);
    } catch {
      return [];
    }
  }

  private executeWithStatement(conn: snowflake.Connection, sql: string): Promise<{ rows: any[]; statement: snowflake.RowStatement }> {
    return new Promise((resolve, reject) => {
      conn.execute({
        sqlText: sql,
        complete: (err: Error | undefined, stmt: snowflake.RowStatement, rows: any[] | undefined) => {
          if (err) reject(err);
          else resolve({ rows: rows || [], statement: stmt });
        }
      });
    });
  }
}
