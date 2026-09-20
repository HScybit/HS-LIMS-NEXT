-- Cover current child selection, including non-default/primary legacy records.
-- Existing uniqueness, ownership, history and access constraints are unchanged.
CREATE INDEX customer_address_parent_idx ON customer_addresses (organization_id,customer_id,address_type,id);
--> statement-breakpoint
CREATE INDEX customer_contact_parent_idx ON customer_contacts (organization_id,customer_id,id);
