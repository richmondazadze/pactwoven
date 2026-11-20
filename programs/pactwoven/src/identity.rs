use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::constants::*;

pub fn organization_key(uuid: &[u8; 16]) -> [u8; 32] {
    hashv(&[b"pactwoven:org-registration:v1\0", uuid]).to_bytes()
}

pub fn responsibility_key(organization: &[u8; 16], responsibility: &[u8; 16]) -> [u8; 32] {
    hashv(&[
        b"pactwoven:responsibility-registration:v1\0",
        organization,
        responsibility,
    ])
    .to_bytes()
}

pub fn physical_asset_key() -> [u8; 32] {
    hashv(&[
        b"pactwoven:solana-asset:v1\0",
        &DEVNET_GENESIS,
        TOKEN_PROGRAM.as_ref(),
        TEST_MINT.as_ref(),
    ])
    .to_bytes()
}

pub fn setup_policy_hash() -> [u8; 32] {
    hashv(&[
        b"pactwoven:chain0-init-policy:v1\0",
        &[
            LAYOUT_VERSION,
            INITIALIZATION_ONLY,
            DEVELOPMENT_NAMESPACE,
            ASSET_DECIMALS,
        ],
        &DEVNET_GENESIS,
        TOKEN_PROGRAM.as_ref(),
        TEST_MINT.as_ref(),
        &PHYSICAL_ASSET_KEY,
    ])
    .to_bytes()
}

pub fn config_operation_key(program: &Pubkey, config: &Pubkey) -> [u8; 32] {
    hashv(&[
        b"pactwoven:config-setup-op:v1\0",
        program.as_ref(),
        config.as_ref(),
    ])
    .to_bytes()
}

pub fn custody_operation_key(program: &Pubkey, registration: &Pubkey) -> [u8; 32] {
    hashv(&[
        b"pactwoven:custody-setup-op:v1\0",
        program.as_ref(),
        registration.as_ref(),
    ])
    .to_bytes()
}

pub struct ConfigIntent<'a> {
    pub program: &'a Pubkey,
    pub config: &'a Pubkey,
    pub program_data: &'a Pubkey,
    pub deployment_slot: u64,
    pub bootstrap_authority: &'a Pubkey,
    pub registrar: &'a Pubkey,
    pub rent_payer: &'a Pubkey,
}

pub fn config_intent_hash(intent: &ConfigIntent<'_>) -> [u8; 32] {
    hashv(&[
        b"pactwoven:config-setup-intent:v1\0",
        intent.program.as_ref(),
        intent.config.as_ref(),
        intent.program_data.as_ref(),
        &intent.deployment_slot.to_le_bytes(),
        intent.bootstrap_authority.as_ref(),
        intent.registrar.as_ref(),
        intent.rent_payer.as_ref(),
        &DEVNET_GENESIS,
        TOKEN_PROGRAM.as_ref(),
        TEST_MINT.as_ref(),
        &PHYSICAL_ASSET_KEY,
        &setup_policy_hash(),
        &config_operation_key(intent.program, intent.config),
    ])
    .to_bytes()
}

pub struct CustodyIntent<'a> {
    pub program: &'a Pubkey,
    pub config: &'a Pubkey,
    pub config_intent_hash: &'a [u8; 32],
    pub registration: &'a Pubkey,
    pub vault: &'a Pubkey,
    pub organization_key: &'a [u8; 32],
    pub responsibility_key: &'a [u8; 32],
    pub owner: &'a Pubkey,
    pub registrar: &'a Pubkey,
    pub rent_payer: &'a Pubkey,
    pub owner_binding_hash: &'a [u8; 32],
}

pub fn custody_intent_hash(intent: &CustodyIntent<'_>) -> [u8; 32] {
    hashv(&[
        b"pactwoven:custody-setup-intent:v1\0",
        intent.program.as_ref(),
        intent.config.as_ref(),
        intent.config_intent_hash,
        intent.registration.as_ref(),
        intent.vault.as_ref(),
        intent.organization_key,
        intent.responsibility_key,
        &PHYSICAL_ASSET_KEY,
        intent.owner.as_ref(),
        intent.registrar.as_ref(),
        intent.rent_payer.as_ref(),
        intent.owner_binding_hash,
        &custody_operation_key(intent.program, intent.registration),
    ])
    .to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::str::FromStr;

    #[test]
    fn rust_pdas_match_independent_public_reference_vector() {
        let org = [
            0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255,
        ];
        let responsibility = [
            16, 33, 50, 67, 84, 101, 118, 135, 152, 169, 186, 203, 220, 237, 254, 15,
        ];
        let (config, config_bump) = Pubkey::find_program_address(&[CONFIG_SEED], &crate::ID);
        let (registration, registration_bump) = Pubkey::find_program_address(
            &[
                CUSTODY_SEED,
                &organization_key(&org),
                &responsibility_key(&org, &responsibility),
                &PHYSICAL_ASSET_KEY,
            ],
            &crate::ID,
        );
        let (vault, vault_bump) =
            Pubkey::find_program_address(&[VAULT_SEED, registration.as_ref()], &crate::ID);
        assert_eq!(
            config,
            Pubkey::from_str("6nCoQdJQFYiz4s8JY3d5oZb38hBrTJayvxk5xib9SvDs").unwrap()
        );
        assert_eq!(
            registration,
            Pubkey::from_str("5hjBxuek2xmzGN72Dbkritxbcu1VfPNWh2S7p6SYa7b6").unwrap()
        );
        assert_eq!(
            vault,
            Pubkey::from_str("J4m5cddfaxefvhQuxt6YbvVtLFpfA8DuNqzCXyBa7uvz").unwrap()
        );
        assert_eq!(
            (config_bump, registration_bump, vault_bump),
            (255, 255, 255)
        );
    }

    #[test]
    fn asset_hash_is_the_accepted_physical_key() {
        assert_eq!(physical_asset_key(), PHYSICAL_ASSET_KEY);
    }

    #[test]
    fn domain_and_organization_separate_registration_keys() {
        let a = [1; 16];
        let b = [2; 16];
        assert_ne!(organization_key(&a), responsibility_key(&a, &a));
        assert_ne!(responsibility_key(&a, &b), responsibility_key(&b, &b));
        assert_ne!(responsibility_key(&a, &b), responsibility_key(&b, &a));
    }

    #[test]
    fn operation_identity_is_bound_to_program_and_target() {
        let a = Pubkey::new_from_array([1; 32]);
        let b = Pubkey::new_from_array([2; 32]);
        assert_ne!(config_operation_key(&a, &a), custody_operation_key(&a, &a));
        assert_ne!(custody_operation_key(&a, &a), custody_operation_key(&a, &b));
        assert_ne!(custody_operation_key(&a, &b), custody_operation_key(&b, &b));
    }

    #[test]
    fn config_intent_binds_authorities_payer_and_deployment() {
        let a = Pubkey::new_from_array([1; 32]);
        let b = Pubkey::new_from_array([2; 32]);
        let mut intent = ConfigIntent {
            program: &crate::ID,
            config: &a,
            program_data: &a,
            deployment_slot: 1,
            bootstrap_authority: &a,
            registrar: &a,
            rent_payer: &a,
        };
        let original = config_intent_hash(&intent);
        intent.deployment_slot = 2;
        assert_ne!(original, config_intent_hash(&intent));
        intent.deployment_slot = 1;
        intent.rent_payer = &b;
        assert_ne!(original, config_intent_hash(&intent));
        intent.rent_payer = &a;
        intent.registrar = &b;
        assert_ne!(original, config_intent_hash(&intent));
        intent.registrar = &a;
        intent.bootstrap_authority = &b;
        assert_ne!(original, config_intent_hash(&intent));
    }
}
