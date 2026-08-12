# Changelog

All notable changes to the RunQL Snowflake Connector will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

### Added
- Initial release.
- Snowflake connection provider with key-pair authentication.
- `SnowflakeAdapter` with query execution, non-query execution, and schema introspection (tables, columns, procedures, functions, parameters).
- **Parse & Fill** action for importing JDBC/ODBC/TOML connection strings.
- **RunQL: Snowflake Setup Guide** command and auto-opened setup instructions on first install.

## [1.1.0]

### Added
- Support for connection types in the RunQL Extension/IDE for selecting either data access or db admin connections.

## [1.1.1]

### Added
- Support for connection types in the RunQL Extension/IDE for selecting either data access or db admin connections.

## [1.1.2]

### Added
- Publish to Open VSX marketplace

## [1.2.0]

### Added
- Fixed an issue with schema introspection.

## [1.2.1]

### Added
fix: make Snowflake schema introspection use native metadata

- Scope introspection to the configured schema when one is provided
- Replace unsupported KEY_COLUMN_USAGE queries with SHOW PRIMARY KEYS / SHOW IMPORTED KEYS
- Use Snowflake PROCEDURES and FUNCTIONS metadata instead of ROUTINES / PARAMETERS
- Keep PK, FK, and routine metadata best-effort so table/column introspection is not blocked
- Sort PK/FK metadata by key sequence for composite keys
- Warn when optional metadata introspection fails or SHOW results may be truncated

## [1.3.0]

### Changes

#### More Table Actions in RunQL Explorer

Right-click any table in RunQL Explorer to:

- Copy the table name
- Edit the table
- View table DDL
- Generate SELECT, INSERT, UPDATE, and DELETE templates
- Dump table structure
- Generate mock data
- Copy, drop, or truncate a table