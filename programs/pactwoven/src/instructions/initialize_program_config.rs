use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_spl::token::{Mint, Token};

use crate::{
    constants::*, errors::Chain0Error, identity, instructions::validate_mint, program::Pactwoven,
    state::ProgramConfig,
};

#[derive(Accounts)]
pub struct InitializeProgramConfig<'info> {
    #[account(mut, owner = anchor_lang::system_program::ID)]
    pub rent_payer: Signer<'info>,
    pub bootstrap_authority: Signer<'info>,
    pub registrar: Signer<'info>,
    #[account(
        owner = bpf_loader_upgradeable::ID,
        constraint = pactwoven_program.programdata_address()? == Some(program_data.key())
            @ Chain0Error::WrongProgramData
    )]
    pub pactwoven_program: Program<'info, Pactwoven>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(bootstrap_authority.key())
            @ Chain0Error::WrongUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(
        init,
        payer = rent_payer,
        space = ProgramConfig::SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(address = TEST_MINT @ Chain0Error::WrongMint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_program_config(ctx: Context<InitializeProgramConfig>) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        Chain0Error::UnexpectedAccounts
    );
    validate_mint(&ctx.accounts.mint)?;

    let config_address = ctx.accounts.config.key();
    let program_data = ctx.accounts.program_data.key();
    let authority = ctx.accounts.bootstrap_authority.key();
    let registrar = ctx.accounts.registrar.key();
    let rent_payer = ctx.accounts.rent_payer.key();
    let deployment_slot = ctx.accounts.program_data.slot;
    let setup_intent_hash = identity::config_intent_hash(&identity::ConfigIntent {
        program: ctx.program_id,
        config: &config_address,
        program_data: &program_data,
        deployment_slot,
        bootstrap_authority: &authority,
        registrar: &registrar,
        rent_payer: &rent_payer,
    });

    ctx.accounts.config.set_inner(ProgramConfig {
        version: LAYOUT_VERSION,
        bump: ctx.bumps.config,
        stage: INITIALIZATION_ONLY,
        environment: DEVELOPMENT_NAMESPACE,
        decimals: ASSET_DECIMALS,
        reserved: [0; 3],
        program_data,
        bootstrap_authority: authority,
        registrar,
        rent_payer,
        genesis: DEVNET_GENESIS,
        token_program: TOKEN_PROGRAM,
        mint: TEST_MINT,
        physical_asset_key: PHYSICAL_ASSET_KEY,
        setup_policy_hash: identity::setup_policy_hash(),
        setup_operation_key: identity::config_operation_key(ctx.program_id, &config_address),
        setup_intent_hash,
        program_deployment_slot: deployment_slot,
        created_slot: Clock::get()?.slot,
    });
    Ok(())
}
