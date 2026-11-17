/** Exact managed creator exception shared by both connection admissions.
 * Keep equivalent to 0017 supplier_role_safe; all other role checks stay local.
 * The query alias r is the exact authenticated runtime LOGIN. */
export const supplierRuntimeMembershipPredicate=`NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid OR (m.roleid=r.oid AND NOT(
      m.admin_option AND NOT m.inherit_option AND NOT m.set_option
      -- OID 10 is PostgreSQL's original bootstrap superuser, not a role-name proxy.
      AND m.grantor=10 AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles g WHERE g.oid=m.grantor AND g.rolsuper)
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_namespace owner_schema WHERE owner_schema.nspname='pactwoven'
        AND owner_schema.nspowner=m.member
        AND (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace=owner_schema.oid
          AND c.relname IN ('organizations','memberships','session_revocations','sites')
          AND c.relkind='r' AND c.relrowsecurity AND c.relowner=m.member)=4
        AND (SELECT count(*) FROM pg_catalog.pg_proc f WHERE f.oid=ANY(ARRAY[
          pg_catalog.to_regprocedure('pactwoven.supplier_base_identity(jsonb,jsonb,jsonb)'),
          pg_catalog.to_regprocedure('pactwoven.supplier_observer_identity(text,text,jsonb)')]::oid[])
          AND f.proowner=m.member AND f.prosecdef)=2))))`;
