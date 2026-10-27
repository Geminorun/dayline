\set ON_ERROR_STOP on
\getenv db_name DAYLINE_DATABASE_NAME
\getenv app_user DAYLINE_DATABASE_USER
\getenv app_password DAYLINE_DATABASE_PASSWORD

-- A session lock also covers CREATE DATABASE, which cannot run in a transaction.
SELECT pg_advisory_lock(hashtext('dayline-deployment-initialization'));
SELECT current_setting('server_version_num')::integer / 10000 IN (17, 18) AS supported \gset
\if :supported
\else
  \echo PostgreSQL 17 or 18 is required.
  \quit 3
\endif
SELECT EXISTS(SELECT FROM pg_roles WHERE rolname = :'app_user') AS role_exists \gset
SELECT EXISTS(SELECT FROM pg_database WHERE datname = :'db_name') AS db_exists \gset
\if :role_exists
  SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS safe_role
    FROM pg_roles WHERE rolname = :'app_user' \gset
  \if :safe_role
  \else
    \echo Refusing to reuse a privileged or non-login application role.
    \quit 3
  \endif
\else
  \if :db_exists
    \echo Existing database has no matching application role; refusing to change its owner.
    \quit 3
  \endif
  SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'app_user', :'app_password') \gexec
\endif
\if :db_exists
  SELECT d.datdba = r.oid AND d.datallowconn AND NOT d.datistemplate AS safe_database
    FROM pg_database d CROSS JOIN pg_roles r
    WHERE d.datname = :'db_name' AND r.rolname = :'app_user' \gset
  \if :safe_database
  \else
    \echo Refusing to migrate a database owned by another role or not open for connections.
    \quit 3
  \endif
\else
  SELECT format('CREATE DATABASE %I OWNER %I TEMPLATE template0 ENCODING %L', :'db_name', :'app_user', 'UTF8') \gexec
  SELECT format('REVOKE ALL ON DATABASE %I FROM PUBLIC', :'db_name') \gexec
\endif
SELECT pg_advisory_unlock(hashtext('dayline-deployment-initialization'));
