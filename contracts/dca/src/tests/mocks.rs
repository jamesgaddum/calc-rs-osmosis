use crate::contract::reply;
use crate::msg::{ExecuteMsg, InstantiateMsg};
use base::triggers::time_configuration::TimeInterval;
use base::vaults::dca_vault::PositionType;
use cosmwasm_schema::serde::Serialize;
use cosmwasm_std::{
    to_binary, Addr, BankMsg, Binary, Coin, Decimal256, Empty, Env, Event, MessageInfo, Response,
    StdResult, Uint128, Uint256, Uint64,
};
use cw_multi_test::{App, AppBuilder, Contract, ContractWrapper, Executor};
use kujira::denom::Denom;
use kujira::fin::{
    BookResponse, ExecuteMsg as FINExecuteMsg, InstantiateMsg as FINInstantiateMsg, OrderResponse,
    PoolResponse, QueryMsg as FINQueryMsg,
};
use std::str::FromStr;

pub const USER: &str = "user";
pub const ADMIN: &str = "admin";
pub const DENOM_UKUJI: &str = "ukuji";
pub const DENOM_UTEST: &str = "utest";

pub struct MockApp {
    pub app: App,
    pub dca_contract_address: Addr,
    pub fin_contract_address: Addr,
}

impl MockApp {
    pub fn new(fin_contract: Box<dyn Contract<Empty>>) -> Self {
        let mut app = AppBuilder::new().build(|router, _, storage| {
            router
                .bank
                .init_balance(
                    storage,
                    &Addr::unchecked(ADMIN),
                    vec![
                        Coin {
                            denom: String::from(DENOM_UKUJI),
                            amount: Uint128::new(200),
                        },
                        Coin {
                            denom: String::from(DENOM_UTEST),
                            amount: Uint128::new(200),
                        },
                    ],
                )
                .unwrap();
        });

        let dca_contract_address = Self::instantiate_contract(
            &mut app,
            Box::new(
                ContractWrapper::new(
                    crate::contract::execute,
                    crate::contract::instantiate,
                    crate::contract::query,
                )
                .with_reply(reply),
            ),
            Addr::unchecked(ADMIN),
            &InstantiateMsg {
                admin: String::from(ADMIN),
            },
            "dca",
        );

        let fin_contract_address = Self::instantiate_contract(
            &mut app,
            fin_contract,
            Addr::unchecked(ADMIN),
            &FINInstantiateMsg {
                decimal_delta: None,
                denoms: [Denom::from(DENOM_UTEST), Denom::from(DENOM_UKUJI)],
                owner: Addr::unchecked(ADMIN),
                price_precision: kujira::precision::Precision::DecimalPlaces(3),
            },
            "fin",
        );

        app.init_modules(|router, _, storage| {
            router
                .bank
                .init_balance(
                    storage,
                    &dca_contract_address,
                    vec![
                        Coin {
                            denom: String::from(DENOM_UKUJI),
                            amount: Uint128::new(200),
                        },
                        Coin {
                            denom: String::from(DENOM_UTEST),
                            amount: Uint128::new(200),
                        },
                    ],
                )
                .unwrap();
            router
                .bank
                .init_balance(
                    storage,
                    &fin_contract_address,
                    vec![
                        Coin {
                            denom: String::from(DENOM_UKUJI),
                            amount: Uint128::new(200),
                        },
                        Coin {
                            denom: String::from(DENOM_UTEST),
                            amount: Uint128::new(200),
                        },
                    ],
                )
                .unwrap();
        });

        app.execute_contract(
            Addr::unchecked(ADMIN),
            dca_contract_address.clone(),
            &ExecuteMsg::CreatePair {
                address: fin_contract_address.to_string(),
                base_denom: DENOM_UTEST.to_string(),
                quote_denom: DENOM_UKUJI.to_string(),
            },
            &[],
        )
        .unwrap();

        Self {
            app,
            dca_contract_address,
            fin_contract_address,
        }
    }

    fn instantiate_contract<T: Serialize>(
        app: &mut App,
        contract: Box<dyn Contract<Empty>>,
        sender: Addr,
        msg: &T,
        label: &str,
    ) -> Addr {
        let code_id = app.store_code(contract);
        let contract_address = app
            .instantiate_contract(code_id, sender, msg, &[], label, None)
            .unwrap();

        contract_address
    }

    pub fn with_funds_for(mut self, address: &Addr, amount: Uint128, denom: &str) -> MockApp {
        self.app.init_modules(|router, _, storage| {
            router
                .bank
                .init_balance(
                    storage,
                    address,
                    vec![Coin {
                        denom: String::from(denom),
                        amount,
                    }],
                )
                .unwrap();
        });
        self
    }

    pub fn with_vault_with_fin_limit_price_trigger(mut self, owner: &Addr) -> MockApp {
        let create_vault_with_price_trigger_message =
            ExecuteMsg::CreateVaultWithFINLimitOrderTrigger {
                pair_address: self.fin_contract_address.to_string(),
                position_type: PositionType::Enter,
                slippage_tolerance: None,
                swap_amount: Uint128::new(10),
                time_interval: TimeInterval::Hourly,
                target_price: Decimal256::from_str("1.0").unwrap(),
            };

        let funds = vec![Coin {
            denom: String::from(DENOM_UKUJI),
            amount: Uint128::new(100),
        }];

        self.app
            .execute_contract(
                owner.clone(),
                self.dca_contract_address.clone(),
                &create_vault_with_price_trigger_message,
                &funds,
            )
            .unwrap();

        self
    }

    pub fn with_vault_with_partially_filled_fin_limit_price_trigger(
        mut self,
        owner: &Addr,
    ) -> MockApp {
        let create_vault_with_price_trigger_message =
            ExecuteMsg::CreateVaultWithFINLimitOrderTrigger {
                pair_address: self.fin_contract_address.to_string(),
                position_type: PositionType::Enter,
                slippage_tolerance: None,
                swap_amount: Uint128::new(10),
                time_interval: TimeInterval::Hourly,
                target_price: Decimal256::from_str("1.0").unwrap(),
            };

        let funds = vec![Coin {
            denom: String::from(DENOM_UKUJI),
            amount: Uint128::new(100),
        }];

        self.app
            .execute_contract(
                owner.clone(),
                self.dca_contract_address.clone(),
                &create_vault_with_price_trigger_message,
                &funds,
            )
            .unwrap();

        // send 5 ukuji from fin to admin wallet to mock partially filled outgoing
        self.app
            .send_tokens(
                self.fin_contract_address.clone(),
                Addr::unchecked(ADMIN),
                &[Coin {
                    denom: String::from(DENOM_UKUJI),
                    amount: Uint128::new(5),
                }],
            )
            .unwrap();

        // send 5 utest from admin wallet to fin to mock partially filled incoming
        self.app
            .send_tokens(
                Addr::unchecked(ADMIN),
                self.fin_contract_address.clone(),
                &[Coin {
                    denom: String::from(DENOM_UTEST),
                    amount: Uint128::new(5),
                }],
            )
            .unwrap();

        self
    }

    pub fn with_vault_with_time_trigger(mut self, owner: &Addr) -> MockApp {
        let create_vault_with_price_trigger_message = ExecuteMsg::CreateVaultWithTimeTrigger {
            pair_address: self.fin_contract_address.to_string(),
            position_type: PositionType::Enter,
            slippage_tolerance: None,
            swap_amount: Uint128::new(10),
            time_interval: TimeInterval::Hourly,
            target_start_time_utc_seconds: Some(Uint64::from(
                self.app.block_info().time.plus_seconds(2).seconds(),
            )),
        };

        let funds = vec![Coin {
            denom: String::from(DENOM_UKUJI),
            amount: Uint128::new(100),
        }];

        self.app
            .execute_contract(
                owner.clone(),
                self.dca_contract_address.clone(),
                &create_vault_with_price_trigger_message,
                &funds,
            )
            .unwrap();

        self
    }

    pub fn elapse_time(&mut self, seconds: u64) {
        self.app.update_block(|mut block_info| {
            block_info.time = block_info.time.plus_seconds(seconds);
            let seconds_per_block = 5u64;
            block_info.height += seconds / seconds_per_block;
        });
    }

    pub fn get_balance(&self, address: &Addr, denom: &str) -> Uint128 {
        self.app
            .wrap()
            .query_balance(address.clone(), denom)
            .unwrap()
            .amount
    }
}

fn default_swap_handler(info: MessageInfo) -> StdResult<Response> {
    let received_coin = info.funds[0].clone();
    let coin_to_send = match received_coin.denom.as_str() {
        DENOM_UKUJI => Coin {
            denom: String::from(DENOM_UTEST),
            amount: received_coin.amount,
        },
        DENOM_UTEST => Coin {
            denom: String::from(DENOM_UKUJI),
            amount: received_coin.amount,
        },
        _ => Coin {
            denom: String::from(DENOM_UTEST),
            amount: received_coin.amount,
        },
    };

    Ok(Response::new()
        .add_event(
            Event::new("trade")
                .add_attribute("market", "value")
                .add_attribute("base_amount", received_coin.amount.clone())
                .add_attribute("quote_amount", received_coin.amount.clone()),
        )
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![coin_to_send],
        }))
}

fn default_submit_order_handler() -> StdResult<Response> {
    Ok(Response::new().add_attribute("order_idx", "1"))
}

fn default_withdraw_orders_handler(
    info: MessageInfo,
    order_ids: Option<Vec<Uint128>>,
) -> StdResult<Response> {
    let mut response = Response::new();
    if let Some(order_ids) = order_ids {
        for _ in order_ids {
            response = response.add_message(BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![Coin {
                    denom: String::from(DENOM_UTEST),
                    amount: Uint128::new(10),
                }],
            })
        }
    }
    Ok(response)
}

fn withdraw_partially_filled_order_handler(
    info: MessageInfo,
    order_ids: Option<Vec<Uint128>>,
) -> StdResult<Response> {
    let mut response = Response::new();
    if let Some(order_ids) = order_ids {
        for _ in order_ids {
            response = response.add_message(BankMsg::Send {
                to_address: info.sender.to_string(),
                amount: vec![Coin {
                    denom: String::from(DENOM_UTEST),
                    amount: Uint128::new(5),
                }],
            })
        }
    }
    Ok(response)
}

fn default_retract_order_handler(info: MessageInfo) -> StdResult<Response> {
    Ok(Response::new()
        .add_attribute("amount", "10")
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin {
                denom: String::from(DENOM_UKUJI),
                amount: Uint128::new(10),
            }],
        }))
}

fn retract_partially_filled_order_handler(info: MessageInfo) -> StdResult<Response> {
    Ok(Response::new()
        .add_attribute("amount", "5")
        .add_message(BankMsg::Send {
            to_address: info.sender.to_string(),
            amount: vec![Coin {
                denom: String::from(DENOM_UKUJI),
                amount: Uint128::new(5),
            }],
        }))
}

fn default_book_response() -> StdResult<Binary> {
    book_response(
        String::from(DENOM_UTEST),
        Decimal256::from_str("10")?,
        Decimal256::from_str("10")?,
    )
}

fn book_response(
    quote_denom: String,
    base_price: Decimal256,
    quote_price: Decimal256,
) -> StdResult<Binary> {
    let pool_response_quote = PoolResponse {
        quote_price,
        offer_denom: Denom::from(quote_denom.clone()),
        total_offer_amount: Uint256::zero(),
    };

    let pool_response_base = PoolResponse {
        quote_price: base_price,
        offer_denom: Denom::from(quote_denom),
        total_offer_amount: Uint256::zero(),
    };

    to_binary(&BookResponse {
        base: vec![pool_response_base.clone()],
        quote: vec![pool_response_quote.clone()],
    })
}

fn default_order_response(env: Env) -> StdResult<Binary> {
    let response = OrderResponse {
        created_at: env.block.time,
        owner: Addr::unchecked(USER),
        idx: Uint128::new(1),
        quote_price: Decimal256::from_str("1.0").unwrap(),
        original_offer_amount: Uint256::from_str("10").unwrap(),
        filled_amount: Uint256::from_str("10").unwrap(),
        offer_denom: Denom::from(DENOM_UKUJI),
        offer_amount: Uint256::zero(),
    };
    Ok(to_binary(&response)?)
}

fn partially_filled_order_response(env: Env) -> StdResult<Binary> {
    let response = OrderResponse {
        idx: Uint128::new(1),
        owner: Addr::unchecked(USER),
        quote_price: Decimal256::from_str("1.0").unwrap(),
        offer_denom: Denom::from(DENOM_UKUJI),
        offer_amount: Uint256::from_str("5").unwrap(),
        filled_amount: Uint256::from_str("5").unwrap(),
        created_at: env.block.time,
        original_offer_amount: Uint256::from_str("10").unwrap(),
    };
    Ok(to_binary(&response)?)
}

pub fn fin_contract_default() -> Box<dyn Contract<Empty>> {
    let contract = ContractWrapper::new(
        |_, _, info, msg: FINExecuteMsg| -> StdResult<Response> {
            match msg {
                FINExecuteMsg::Swap {
                    belief_price: _,
                    max_spread: _,
                    to: _,
                    offer_asset: _,
                } => default_swap_handler(info),
                FINExecuteMsg::SubmitOrder { price: _ } => default_submit_order_handler(),
                FINExecuteMsg::WithdrawOrders { order_idxs } => {
                    default_withdraw_orders_handler(info, order_idxs)
                }
                FINExecuteMsg::RetractOrder {
                    order_idx: _,
                    amount: _,
                } => default_retract_order_handler(info),
                _ => Ok(Response::default()),
            }
        },
        |_, _, _, _: FINInstantiateMsg| -> StdResult<Response> { Ok(Response::new()) },
        |_, env, msg: FINQueryMsg| -> StdResult<Binary> {
            match msg {
                FINQueryMsg::Book {
                    limit: _,
                    offset: _,
                } => default_book_response(),
                FINQueryMsg::Order { order_idx: _ } => default_order_response(env),
                _ => {
                    #[derive(Serialize)]
                    pub struct Mock;
                    Ok(to_binary(&Mock)?)
                }
            }
        },
    );
    Box::new(contract)
}

pub fn fin_contract_fail_slippage_tolerance() -> Box<dyn Contract<Empty>> {
    let contract = ContractWrapper::new(
        |_, _, _, msg: FINExecuteMsg| -> StdResult<Response> {
            match msg {
                FINExecuteMsg::Swap {
                    belief_price: _,
                    max_spread: _,
                    offer_asset: _,
                    to: _,
                } => Err(cosmwasm_std::StdError::GenericErr {
                    msg: String::from("Max spread exceeded 0.992445703493862134"),
                }),
                _ => Ok(Response::default()),
            }
        },
        |_, _, _, _: FINInstantiateMsg| -> StdResult<Response> { Ok(Response::new()) },
        |_, _, msg: FINQueryMsg| -> StdResult<Binary> {
            match msg {
                _ => {
                    #[derive(Serialize)]
                    pub struct Mock;
                    Ok(to_binary(&Mock)?)
                }
            }
        },
    );
    Box::new(contract)
}

pub fn fin_contract_partially_filled_order() -> Box<dyn Contract<Empty>> {
    let contract = ContractWrapper::new(
        |_, _, info, msg: FINExecuteMsg| -> StdResult<Response> {
            match msg {
                FINExecuteMsg::SubmitOrder { price: _ } => default_submit_order_handler(),
                FINExecuteMsg::RetractOrder {
                    order_idx: _,
                    amount: _,
                } => retract_partially_filled_order_handler(info),
                FINExecuteMsg::WithdrawOrders { order_idxs } => {
                    withdraw_partially_filled_order_handler(info, order_idxs)
                }
                _ => Ok(Response::default()),
            }
        },
        |_, _, _, _: FINInstantiateMsg| -> StdResult<Response> { Ok(Response::new()) },
        |_, env, msg: FINQueryMsg| -> StdResult<Binary> {
            match msg {
                FINQueryMsg::Order { order_idx: _ } => partially_filled_order_response(env),
                _ => {
                    #[derive(Serialize)]
                    pub struct Mock;
                    Ok(to_binary(&Mock)?)
                }
            }
        },
    );
    Box::new(contract)
}