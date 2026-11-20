use anchor_lang::prelude::*;

use crate::{constants::*, errors::Chain0Error, identity};

#[account]
#[derive(InitSpace, Default)]
pub struct ProgramConfig {
    pub version: u8,
    pub bump: u8,
    pub stage: u8,
    pub environment: u8,
    pub decimals: u8,
    pub reserved: [u8; 3],
    pub program_data: Pubkey,
    pub bootstrap_authority: Pubkey,
    pub registrar: Pubkey,
    pub rent_payer: Pubkey,
    pub genesis: [u8; 32],
    pub token_program: Pubkey,
    pub mint: Pubkey,
    pub physical_asset_key: [u8; 32],
    pub setup_policy_hash: [u8; 32],
    pub setup_operation_key: [u8; 32],
    pub setup_intent_hash: [u8; 32],
    pub program_deployment_slot: u64,
    pub created_slot: u64,
}

impl ProgramConfig {
    pub const SPACE: usize = 8 + Self::INIT_SPACE;

    pub fn validate(&self, address: &Pubkey, canonical_bump: u8) -> Result<()> {
        require!(
            self.version == LAYOUT_VERSION
                && self.bump == canonical_bump
                && self.stage == INITIALIZATION_ONLY
                && self.environment == DEVELOPMENT_NAMESPACE
                && self.decimals == ASSET_DECIMALS
                && self.reserved == [0; 3]
                && self.genesis == DEVNET_GENESIS
                && self.token_program == TOKEN_PROGRAM
                && self.mint == TEST_MINT
                && self.physical_asset_key == PHYSICAL_ASSET_KEY,
            Chain0Error::InvalidConfiguration
        );
        require!(
            self.setup_policy_hash == identity::setup_policy_hash()
                && self.setup_operation_key == identity::config_operation_key(&crate::ID, address)
                && self.setup_intent_hash
                    == identity::config_intent_hash(&identity::ConfigIntent {
                        program: &crate::ID,
                        config: address,
                        program_data: &self.program_data,
                        deployment_slot: self.program_deployment_slot,
                        bootstrap_authority: &self.bootstrap_authority,
                        registrar: &self.registrar,
                        rent_payer: &self.rent_payer,
                    }),
            Chain0Error::InvalidConfigurationIdentity
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace, Default)]
pub struct CustodyRegistration {
    pub version: u8,
    pub bump: u8,
    pub vault_bump: u8,
    pub stage: u8,
    pub reserved: [u8; 4],
    pub config: Pubkey,
    pub organization_key: [u8; 32],
    pub responsibility_key: [u8; 32],
    pub physical_asset_key: [u8; 32],
    pub owner: Pubkey,
    pub registrar: Pubkey,
    pub rent_payer: Pubkey,
    pub vault: Pubkey,
    pub owner_binding_hash: [u8; 32],
    pub setup_operation_key: [u8; 32],
    pub setup_intent_hash: [u8; 32],
    pub created_slot: u64,
}

impl CustodyRegistration {
    pub const SPACE: usize = 8 + Self::INIT_SPACE;
}

const _: [(); 384] = [(); ProgramConfig::SPACE];
const _: [(); 376] = [(); CustodyRegistration::SPACE];

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{Discriminator, InstructionData};

    #[test]
    fn account_wire_sizes_and_discriminators_are_fixed() {
        let mut config = Vec::new();
        ProgramConfig::default().try_serialize(&mut config).unwrap();
        let mut custody = Vec::new();
        CustodyRegistration::default()
            .try_serialize(&mut custody)
            .unwrap();
        assert_eq!(config.len(), 384);
        assert_eq!(custody.len(), 376);
        assert_eq!(
            ProgramConfig::DISCRIMINATOR,
            &[196, 210, 90, 231, 144, 149, 140, 63]
        );
        assert_eq!(
            CustodyRegistration::DISCRIMINATOR,
            &[11, 96, 162, 69, 159, 209, 89, 71]
        );
    }

    #[test]
    fn initialization_instruction_wire_contract_is_fixed() {
        let config = crate::instruction::InitializeProgramConfig {}.data();
        assert_eq!(config, [6, 131, 61, 237, 40, 110, 83, 124]);
        let custody = crate::instruction::InitializeCustody {
            organization_uuid: [1; 16],
            responsibility_uuid: [2; 16],
            owner_binding_hash: [3; 32],
        }
        .data();
        assert_eq!(custody.len(), 72);
        assert_eq!(&custody[..8], &[229, 218, 228, 120, 208, 239, 223, 234]);
        assert_eq!(&custody[8..24], &[1; 16]);
        assert_eq!(&custody[24..40], &[2; 16]);
        assert_eq!(&custody[40..], &[3; 32]);
    }
}
