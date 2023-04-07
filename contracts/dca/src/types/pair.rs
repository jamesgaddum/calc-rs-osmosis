use cosmwasm_schema::cw_serde;
use cosmwasm_std::Addr;

#[cw_serde]
pub struct Pair {
    pub address: Addr,
    pub base_denom: String,
    pub quote_denom: String,
    pub pool_id: u64,
}
