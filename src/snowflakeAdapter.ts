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

      const [schemaRows, tableRows, columnRows, primaryKeyRows, foreignKeyRows, routineRows, parameterRows] = await Promise.all([
        this.execute(conn, this.buildSchemasIntrospectionSql(targetDatabase)),
        this.execute(conn, this.buildTablesIntrospectionSql(targetDatabase)),
        this.execute(conn, this.buildColumnsIntrospectionSql(targetDatabase)),
        this.execute(conn, this.buildPrimaryKeysIntrospectionSql(targetDatabase)),
        this.execute(conn, this.buildForeignKeysIntrospectionSql(targetDatabase)),
        this.execute(conn, this.buildRoutinesIntrospectionSql(targetDatabase)),
        this.execute(conn, this.buildRoutineParametersSql(targetDatabase))
      ]);

      const schemasMap = new Map<string, SnowflakeSchemaEntry>();
      const tableTypeMap = new Map<string, string>();
      const tableCommentMap = new Map<string, string | undefined>();
      const routinesBySpecificName = new Map<string, RoutineModel>();

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
        const specificName = this.getRowString(row, ['SPECIFIC_NAME', 'specific_name']);
        const returnType = this.getRowString(row, ['DATA_TYPE', 'data_type']);

        if (!schemaName || !routineName) {
          continue;
        }

        const schema = this.ensureSchema(schemasMap, schemaName);

        const kind = routineTypeRaw.toUpperCase() === 'PROCEDURE' ? 'procedure' : 'function';
        const routine: RoutineModel = {
          name: routineName,
          kind,
          returnType: kind === 'function' ? returnType || undefined : undefined,
          parameters: []
        };

        if (kind === 'procedure') {
          schema.procedures.push(routine);
        } else {
          schema.functions.push(routine);
        }

        const keyName = specificName || routineName;
        routinesBySpecificName.set(this.routineSpecificKey(schemaName, keyName), routine);
      }

      for (const row of parameterRows) {
        const schemaName = this.getRowString(row, ['SPECIFIC_SCHEMA', 'specific_schema']);
        const specificName = this.getRowString(row, ['SPECIFIC_NAME', 'specific_name']);
        const modeRaw = this.getRowString(row, ['PARAMETER_MODE', 'parameter_mode']);
        const dataType = this.getRowString(row, ['DATA_TYPE', 'data_type']);
        const ordinalPosition = this.getRowNumber(row, ['ORDINAL_POSITION', 'ordinal_position']);
        const parameterNameRaw = this.getRowString(row, ['PARAMETER_NAME', 'parameter_name']);

        if (!schemaName || !specificName) {
          continue;
        }

        const routine = routinesBySpecificName.get(this.routineSpecificKey(schemaName, specificName));
        if (!routine) {
          continue;
        }

        const mode = this.normalizeParameterMode(modeRaw);
        const position = typeof ordinalPosition === 'number' ? ordinalPosition : undefined;
        const generatedName = position ? `arg${position}` : 'arg';
        const parameterName = parameterNameRaw?.trim() || (mode === 'return' ? 'return_value' : generatedName);

        routine.parameters = routine.parameters ?? [];
        routine.parameters.push({
          name: parameterName,
          mode,
          type: dataType || undefined,
          position
        });

        if (!routine.returnType && mode === 'return' && dataType) {
          routine.returnType = dataType;
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

  private buildSchemasIntrospectionSql(databaseName: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT SCHEMA_NAME
      FROM ${db}.INFORMATION_SCHEMA.SCHEMATA
      WHERE SCHEMA_NAME NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ORDER BY SCHEMA_NAME
    `;
  }

  private buildTablesIntrospectionSql(databaseName: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT
        TABLE_SCHEMA,
        TABLE_NAME,
        TABLE_TYPE,
        COMMENT
      FROM ${db}.INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ORDER BY TABLE_SCHEMA, TABLE_NAME
    `;
  }

  private buildColumnsIntrospectionSql(databaseName: string): string {
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
      ORDER BY TABLE_CATALOG, TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION
    `;
  }

  private buildPrimaryKeysIntrospectionSql(databaseName: string): string {
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
      ORDER BY kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.ORDINAL_POSITION
    `;
  }

  private buildForeignKeysIntrospectionSql(databaseName: string): string {
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
      ORDER BY fk.TABLE_SCHEMA, fk.TABLE_NAME, tc.CONSTRAINT_NAME, fk.ORDINAL_POSITION
    `;
  }

  private buildRoutinesIntrospectionSql(databaseName: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT
        ROUTINE_SCHEMA,
        ROUTINE_NAME,
        SPECIFIC_NAME,
        ROUTINE_TYPE,
        DATA_TYPE
      FROM ${db}.INFORMATION_SCHEMA.ROUTINES
      WHERE ROUTINE_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ORDER BY ROUTINE_SCHEMA, ROUTINE_NAME, SPECIFIC_NAME
    `;
  }

  private buildRoutineParametersSql(databaseName: string): string {
    const db = this.quoteIdentifier(databaseName);
    return `
      SELECT
        SPECIFIC_SCHEMA,
        SPECIFIC_NAME,
        PARAMETER_NAME,
        PARAMETER_MODE,
        DATA_TYPE,
        ORDINAL_POSITION
      FROM ${db}.INFORMATION_SCHEMA.PARAMETERS
      WHERE SPECIFIC_SCHEMA NOT IN ('INFORMATION_SCHEMA', 'DELETED')
      ORDER BY SPECIFIC_SCHEMA, SPECIFIC_NAME, ORDINAL_POSITION
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

  private getRowNumber(row: Record<string, unknown>, keys: string[]): number | undefined {
    for (const key of keys) {
      const direct = row[key];
      if (typeof direct === 'number' && Number.isFinite(direct)) {
        return direct;
      }
      if (typeof direct === 'string' && direct.trim() !== '') {
        const parsed = Number(direct);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }

    const lowerKeys = new Set(keys.map((k) => k.toLowerCase()));
    for (const [key, value] of Object.entries(row)) {
      if (!lowerKeys.has(key.toLowerCase())) {
        continue;
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
      }
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    }

    return undefined;
  }

  private routineSpecificKey(schemaName: string, specificName: string): string {
    return `${schemaName.toUpperCase()}::${specificName.toUpperCase()}`;
  }

  private normalizeParameterMode(modeRaw: string | undefined): 'in' | 'out' | 'inout' | 'variadic' | 'return' | undefined {
    const value = (modeRaw ?? '').trim().toUpperCase();
    if (value === 'IN') return 'in';
    if (value === 'OUT') return 'out';
    if (value === 'INOUT') return 'inout';
    if (value === 'VARIADIC') return 'variadic';
    if (value === 'RETURN') return 'return';
    return undefined;
  }

  private buildRoutineSignature(routine: RoutineModel): string {
    const args = (routine.parameters ?? [])
      .filter((parameter) => parameter.mode !== 'return')
      .map((parameter) => {
        const modePrefix = parameter.mode ? `${parameter.mode.toUpperCase()} ` : '';
        const typeSuffix = parameter.type ? ` ${parameter.type}` : '';
        return `${modePrefix}${parameter.name}${typeSuffix}`.trim();
      })
      .join(', ');
    return `${routine.name}(${args})`;
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
