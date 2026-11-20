use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token::Mint;

use crate::{constants::*, errors::Chain0Error};

pub mod initialize_custody;
pub mod initialize_program_config;

pub use initialize_custody::*;
pub use initialize_program_config::*;

pub(crate) fn validate_mint(mint: &Account<'_, Mint>) -> Result<()> {
    require_keys_eq!(mint.key(), TEST_MINT, Chain0Error::WrongMint);
    require!(
        mint.to_account_info().data_len() == ORIGINAL_MINT_SIZE
            && !mint.to_account_info().executable,
        Chain0Error::WrongAccountLength
    );
    require!(
        mint.is_initialized
            && mint.decimals == ASSET_DECIMALS
            && mint.mint_authority == COption::Some(MINT_AUTHORITY)
            && mint.freeze_authority == COption::Some(FREEZE_AUTHORITY),
        Chain0Error::WrongMintConfiguration
    );
    Ok(())
}
