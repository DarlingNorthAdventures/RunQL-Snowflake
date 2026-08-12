import * as vscode from 'vscode';

export type ConnectionType = 'data_access' | 'db_admin';

export interface ConnectionProfile {
  id: string;
  name: string;
  dialect: string;
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  username?: string;
  ssl?: boolean;
  sslMode?: string;
  authMode?: string;
  credentialStorageMode?: 'session' | 'secretStorage' | 'browser';
  connectionType?: ConnectionType;
  filePath?: string;
  warehouse?: string;
  httpPath?: string;
  account?: string;
  role?: string;
  projectId?: string;
  privateKeyPath?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionSecrets {
  password?: string;
  token?: string;
  privateKeyPassphrase?: string;
  oauthRefreshToken?: string;
  [key: string]: unknown;
}

export interface QueryRunOptions {
  maxRows: number;
  timeoutMs?: number;
}

export interface QueryColumn {
  name: string;
  type?: string;
  normalizedType?: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[];
  rowCount: number;
  elapsedMs: number;
  warning?: string;
}

export interface NonQueryResult {
  affectedRows: number | null;
}

export interface ColumnModel {
  name: string;
  type: string;
  normalizedType?: string;
  nullable?: boolean;
  comment?: string;
}

export interface ForeignKeyModel {
  name?: string;
  column: string;
  foreignSchema: string;
  foreignTable: string;
  foreignColumn: string;
}

export interface IndexModel {
  name: string;
  columns: string[];
  unique: boolean;
}

export interface TableModel {
  name: string;
  comment?: string;
  columns: ColumnModel[];
  primaryKey?: string[];
  foreignKeys?: ForeignKeyModel[];
  indexes?: IndexModel[];
}

export type RoutineKind = 'procedure' | 'function';

export interface RoutineParameterModel {
  name: string;
  mode?: 'in' | 'out' | 'inout' | 'variadic' | 'return';
  type?: string;
  position?: number;
}

export interface RoutineModel {
  name: string;
  kind: RoutineKind;
  comment?: string;
  returnType?: string;
  language?: string;
  deterministic?: boolean;
  schemaQualifiedName?: string;
  signature?: string;
  parameters?: RoutineParameterModel[];
}

export interface SchemaModel {
  name: string;
  tables: TableModel[];
  views?: TableModel[];
  procedures?: RoutineModel[];
  functions?: RoutineModel[];
}

export interface SchemaIntrospection {
  version: '0.2';
  generatedAt: string;
  connectionId: string;
  connectionName?: string;
  dialect: string;
  schemas: SchemaModel[];
}

export interface CopyTableOptions {
  destSchema?: string;
  destTable: string;
  withData: boolean;
}

export interface DbAdapter {
  readonly dialect: string;
  testConnection(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<void>;
  runQuery(profile: ConnectionProfile, secrets: ConnectionSecrets, sql: string, options: QueryRunOptions): Promise<QueryResult>;
  executeNonQuery(profile: ConnectionProfile, secrets: ConnectionSecrets, sql: string): Promise<NonQueryResult>;
  introspectSchema(profile: ConnectionProfile, secrets: ConnectionSecrets): Promise<SchemaIntrospection>;

  // Optional table-operation capabilities. Client falls back to generic SQL
  // when these are absent. See table-item-context-menu.md.
  getTableDdl?(profile: ConnectionProfile, secrets: ConnectionSecrets, schema: string | undefined, table: string): Promise<string>;
  dumpTableStructure?(profile: ConnectionProfile, secrets: ConnectionSecrets, schema: string | undefined, table: string): Promise<string>;
  dumpTableStructureAndData?(profile: ConnectionProfile, secrets: ConnectionSecrets, schema: string | undefined, table: string): Promise<string>;
  copyTable?(profile: ConnectionProfile, secrets: ConnectionSecrets, sourceSchema: string | undefined, sourceTable: string, options: CopyTableOptions): Promise<void>;
  truncateTable?(profile: ConnectionProfile, secrets: ConnectionSecrets, schema: string | undefined, table: string): Promise<void>;
}

export interface DPProviderDescriptor {
  providerId: string;
  displayName: string;
  dialect: string;
  icon?: string;
  formSchema: {
    fields: Array<{
      key: string;
      label: string;
      type: 'text' | 'password' | 'number' | 'checkbox' | 'select' | 'radio' | 'file' | 'textarea';
      tab?: 'connection' | 'auth';
      storage?: 'profile' | 'secrets' | 'local';
      required?: boolean;
      placeholder?: string;
      description?: string;
      defaultValue?: string | number | boolean;
      options?: Array<{ value: string; label: string; description?: string }>;
      min?: number;
      max?: number;
      step?: number;
      width?: 'full' | 'half';
      visibleWhen?: {
        storage?: 'profile' | 'secrets' | 'local';
        key: string;
        equals?: string | number | boolean;
        notEquals?: string | number | boolean;
        truthy?: boolean;
      };
      picker?: {
        mode?: 'open' | 'save';
        title?: string;
        openLabel?: string;
        canSelectFiles?: boolean;
        canSelectFolders?: boolean;
        filters?: Record<string, string[]>;
      };
    }>;
    actions?: Array<{
      id: string;
      label: string;
      tab?: 'connection' | 'auth';
      style?: 'primary' | 'secondary' | 'link';
      payloadKeys?: string[];
    }>;
    reuse?: {
      disabled?: boolean;
      label?: string;
      sourceDialects?: string[];
      includeProfileKeys?: string[];
      excludeProfileKeys?: string[];
      includeSecretKeys?: string[];
      excludeSecretKeys?: string[];
      autoApplyWhenSingle?: boolean;
    };
  };
  supports: {
    ssl: boolean;
    oauth: boolean;
    keypair: boolean;
    introspection: boolean;
    cancellation: boolean;
    dbAdminConnectionType?: boolean;
  };
}

export interface DPProviderActionStatus {
  type: 'info' | 'error' | 'success';
  text: string;
}

export interface DPProviderActionResult {
  profilePatch?: Record<string, unknown>;
  secretsPatch?: Record<string, unknown>;
  localPatch?: Record<string, unknown>;
  status?: DPProviderActionStatus;
}

export type DPProviderActionHandler = (
  actionId: string,
  payload: Record<string, unknown>
) => Promise<DPProviderActionResult | void> | DPProviderActionResult | void;

export interface RunQLExtensionApi {
  registerProvider(descriptor: DPProviderDescriptor): vscode.Disposable;
  registerAdapter(dialect: string, factory: () => DbAdapter): vscode.Disposable;
  registerProviderActionHandler(dialect: string, handler: DPProviderActionHandler): vscode.Disposable;
  getProviders(): DPProviderDescriptor[];
}
