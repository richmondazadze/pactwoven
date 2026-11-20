use anchor_lang::prelude::*;
use anchor_lang::solana_program::{bpf_loader_upgradeable, program_option::COption};
use anchor_spl::token::{self, spl_token::state::AccountState, Mint, Token, TokenAccount};

use crate::{
    constants::*,
    errors::Chain0Error,
    identity,
    instructions::validate_mint,
    program::Pactwoven,
    state::{CustodyRegistration, ProgramConfig},
};

#[derive(Accounts)]
#[instruction(organization_uuid: [u8; 16], responsibility_uuid: [u8; 16])]
pub struct InitializeCustody<'info> {
    #[account(mut, owner = anchor_lang::system_program::ID)]
    pub rent_payer: Signer<'info>,
    #[account(
        constraint = owner.key() != Pubkey::default() && owner.key() != registrar.key()
            @ Chain0Error::InvalidOwner
    )]
    pub owner: Signer<'info>,
    pub registrar: Signer<'info>,
    #[account(
        owner = bpf_loader_upgradeable::ID,
        constraint = pactwoven_program.programdata_address()? == Some(program_data.key())
            @ Chain0Error::WrongProgramData
    )]
    pub pactwoven_program: Program<'info, Pactwoven>,
    #[account(
        constraint = program_data.key() == config.program_data @ Chain0Error::WrongProgramData,
        constraint = program_data.upgrade_authority_address == Some(config.bootstrap_authority)
            @ Chain0Error::WrongUpgradeAuthority,
        constraint = program_data.slot == config.program_deployment_slot @ Chain0Error::DeploymentChanged
    )]
    pub program_data: Account<'info, ProgramData>,
    #[account(
        seeds = [CONFIG_SEED],
        bump,
        constraint = config.to_account_info().data_len() == ProgramConfig::SPACE
            @ Chain0Error::WrongAccountLength,
        constraint = config.registrar == registrar.key() @ Chain0Error::WrongRegistrar
    )]
    pub config: Account<'info, ProgramConfig>,
    #[account(
        init,
        payer = rent_payer,
        space = CustodyRegistration::SPACE,
        seeds = [
            CUSTODY_SEED,
            identity::organization_key(&organization_uuid).as_ref(),
            identity::responsibility_key(&organization_uuid, &responsibility_uuid).as_ref(),
            PHYSICAL_ASSET_KEY.as_ref()
        ],
        bump
    )]
    pub registration: Account<'info, CustodyRegistration>,
    #[account(
        init,
        payer = rent_payer,
        space = ORIGINAL_TOKEN_ACCOUNT_SIZE,
        owner = token_program.key(),
        seeds = [VAULT_SEED, registration.key().as_ref()],
        bump
    )]
    /// CHECK: Fresh exact-size Tokenkeg account, initialized and decoded below in this transaction.
    pub vault: UncheckedAccount<'info>,
    #[account(address = TEST_MINT @ Chain0Error::WrongMint)]
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_custody(
    ctx: Context<InitializeCustody>,
    organization_uuid: [u8; 16],
    responsibility_uuid: [u8; 16],
    owner_binding_hash: [u8; 32],
) -> Result<()> {
    require!(
        ctx.remaining_accounts.is_empty(),
        Chain0Error::UnexpectedAccounts
    );
    require!(
        organization_uuid != [0; 16] && responsibility_uuid != [0; 16],
        Chain0Error::NilRegistrationIdentity
    );
    require!(
        owner_binding_hash != [0; 32],
        Chain0Error::MissingOwnerBinding
    );
    validate_mint(&ctx.accounts.mint)?;
    ctx.accounts
        .config
        .validate(&ctx.accounts.config.key(), ctx.bumps.config)?;
    token::initialize_account3(CpiContext::new(
        ctx.accounts.token_program.key(),
        token::InitializeAccount3 {
            account: ctx.accounts.vault.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            authority: ctx.accounts.registration.to_account_info(),
        },
    ))?;
    let vault_info = ctx.accounts.vault.to_account_info();
    let vault_data = vault_info.try_borrow_data()?;
    let vault = TokenAccount::try_deserialize(&mut vault_data.as_ref())?;
    require!(
        vault_data.len() == ORIGINAL_TOKEN_ACCOUNT_SIZE
            && vault_info.owner == &TOKEN_PROGRAM
            && !vault_info.executable
            && vault.mint == TEST_MINT
            && vault.owner == ctx.accounts.registration.key()
            && vault.amount == 0
            && vault.state == AccountState::Initialized
            && vault.is_native == COption::None
            && vault.delegate == COption::None
            && vault.delegated_amount == 0
            && vault.close_authority == COption::None,
        Chain0Error::InvalidVault
    );

    let config_address = ctx.accounts.config.key();
    let registration_address = ctx.accounts.registration.key();
    let vault_address = ctx.accounts.vault.key();
    let organization_key = identity::organization_key(&organization_uuid);
    let responsibility_key = identity::responsibility_key(&organization_uuid, &responsibility_uuid);
    let owner = ctx.accounts.owner.key();
    let registrar = ctx.accounts.registrar.key();
    let rent_payer = ctx.accounts.rent_payer.key();
    let setup_intent_hash = identity::custody_intent_hash(&identity::CustodyIntent {
        program: ctx.program_id,
        config: &config_address,
        config_intent_hash: &ctx.accounts.config.setup_intent_hash,
        registration: &registration_address,
        vault: &vault_address,
        organization_key: &organization_key,
        responsibility_key: &responsibility_key,
        owner: &owner,
        registrar: &registrar,
        rent_payer: &rent_payer,
        owner_binding_hash: &owner_binding_hash,
    });
    ctx.accounts.registration.set_inner(CustodyRegistration {
        version: LAYOUT_VERSION,
        bump: ctx.bumps.registration,
        vault_bump: ctx.bumps.vault,
        stage: INITIALIZATION_ONLY,
        reserved: [0; 4],
        config: config_address,
        organization_key,
        responsibility_key,
        physical_asset_key: PHYSICAL_ASSET_KEY,
        owner,
        registrar,
        rent_payer,
        vault: vault_address,
        owner_binding_hash,
        setup_operation_key: identity::custody_operation_key(ctx.program_id, &registration_address),
        setup_intent_hash,
        created_slot: Clock::get()?.slot,
    });
    Ok(())
}
