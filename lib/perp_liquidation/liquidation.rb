# frozen_string_literal: true

require 'bigdecimal'
require 'time'

module PerpLiquidation
  class Liquidation
    STATUSES = [
      RECEIVED = 'RECEIVED',
      PLAN_WAITING = 'PLAN_WAITING',
      PENDING = 'PENDING',
      CLAIMED = 'CLAIMED',
      LOCKING = 'LOCKING',
      VALIDATING = 'VALIDATING',
      EXECUTING = 'EXECUTING',
      ORDER_SUBMITTING = 'ORDER_SUBMITTING',
      ORDER_ACCEPTED = 'ORDER_ACCEPTED',
      PARTIALLY_FILLED = 'PARTIALLY_FILLED',
      FILLED = 'FILLED',
      SETTLEMENT_PENDING = 'SETTLEMENT_PENDING',
      BANKRUPTCY_CHECKING = 'BANKRUPTCY_CHECKING',
      INSURANCE_CLAIMING = 'INSURANCE_CLAIMING',
      ADL_REQUIRED = 'ADL_REQUIRED',
      ADL_EXECUTING = 'ADL_EXECUTING',
      ADL_SETTLEMENT_PENDING = 'ADL_SETTLEMENT_PENDING',
      SETTLED = 'SETTLED',
      RESULT_PUBLISHING = 'RESULT_PUBLISHING',
      COMPLETED = 'COMPLETED',
      RETRY_WAIT = 'RETRY_WAIT',
      REJECTED = 'REJECTED',
      CANCELLED = 'CANCELLED',
      EXPIRED = 'EXPIRED',
      SUPERSEDED = 'SUPERSEDED',
      MANUAL_REVIEW = 'MANUAL_REVIEW'
    ].freeze

    TERMINAL_STATUSES = [COMPLETED, REJECTED, CANCELLED, EXPIRED, SUPERSEDED, MANUAL_REVIEW].freeze

    ACTION_PRIORITIES = {
      'LIQUIDATE_POSITION' => 10,
      'CANCEL_RISK_ORDERS' => 20,
      'REDUCE_POSITION' => 50
    }.freeze

    ALLOWED_TRANSITIONS = {
      RECEIVED => [PLAN_WAITING, PENDING, REJECTED, CANCELLED, SUPERSEDED, MANUAL_REVIEW],
      PLAN_WAITING => [PENDING, CANCELLED, SUPERSEDED, MANUAL_REVIEW],
      PENDING => [CLAIMED, REJECTED, CANCELLED, EXPIRED, SUPERSEDED, MANUAL_REVIEW],
      CLAIMED => [PENDING, LOCKING, RETRY_WAIT, REJECTED, EXPIRED, SUPERSEDED],
      LOCKING => [PENDING, VALIDATING, RETRY_WAIT, REJECTED, EXPIRED, SUPERSEDED, MANUAL_REVIEW],
      VALIDATING => [PENDING, EXECUTING, RETRY_WAIT, REJECTED, EXPIRED, SUPERSEDED, MANUAL_REVIEW],
      EXECUTING => [ORDER_SUBMITTING, SETTLED, RETRY_WAIT, REJECTED, MANUAL_REVIEW],
      ORDER_SUBMITTING => [ORDER_ACCEPTED, PARTIALLY_FILLED, FILLED, RETRY_WAIT, REJECTED, MANUAL_REVIEW],
      ORDER_ACCEPTED => [PARTIALLY_FILLED, FILLED, RETRY_WAIT, MANUAL_REVIEW],
      PARTIALLY_FILLED => [FILLED, RETRY_WAIT, MANUAL_REVIEW],
      FILLED => [SETTLEMENT_PENDING, MANUAL_REVIEW],
      SETTLEMENT_PENDING => [PENDING, BANKRUPTCY_CHECKING, SETTLED, RETRY_WAIT, MANUAL_REVIEW],
      BANKRUPTCY_CHECKING => [INSURANCE_CLAIMING, SETTLED, RETRY_WAIT, MANUAL_REVIEW],
      INSURANCE_CLAIMING => [ADL_REQUIRED, SETTLED, RETRY_WAIT, MANUAL_REVIEW],
      ADL_REQUIRED => [ADL_EXECUTING, RETRY_WAIT, MANUAL_REVIEW],
      ADL_EXECUTING => [ADL_SETTLEMENT_PENDING, RETRY_WAIT, MANUAL_REVIEW],
      ADL_SETTLEMENT_PENDING => [SETTLED, RETRY_WAIT, MANUAL_REVIEW],
      SETTLED => [RESULT_PUBLISHING, MANUAL_REVIEW],
      RESULT_PUBLISHING => [COMPLETED],
      RETRY_WAIT => [PENDING, CANCELLED, EXPIRED, SUPERSEDED, MANUAL_REVIEW],
      COMPLETED => [], REJECTED => [], CANCELLED => [], EXPIRED => [], SUPERSEDED => [], MANUAL_REVIEW => []
    }.freeze

    DECIMAL_FIELDS = %i[
      target_quantity max_executable_quantity max_slippage bankruptcy_price
      max_liquidation_deviation max_child_quantity min_child_quantity
      max_book_participation authorized_notional executed_quantity average_price fee
    ].freeze

    ATTRIBUTES = %i[
      task_id risk_decision_id risk_unit_id decision_sequence action priority user_id account_id
      position_id position_version symbol position_side target_quantity
      max_executable_quantity quantity_mode order_type reduce_only time_in_force max_slippage
      bankruptcy_price max_liquidation_deviation quote_max_age_ms
      execution_strategy execution_urgency max_child_orders max_child_quantity
      min_child_quantity max_book_participation child_order_cooldown_ms child_order_timeout_ms
      execution_scope_id portfolio_plan_id plan_item_sequence authorized_notional
      status claimed_by claim_expires_at fencing_token order_id executed_quantity average_price fee
      settled_position_version retry_count next_retry_at error_code error_message
      expire_at created_at updated_at completed_at
    ].freeze

    attr_accessor(*ATTRIBUTES)

    def initialize(attributes)
      ATTRIBUTES.each do |name|
        value = attributes.key?(name) ? attributes[name] : attributes[name.to_s]
        public_send("#{name}=", normalize_value(name, value))
      end
      self.status ||= RECEIVED
      self.priority ||= ACTION_PRIORITIES.fetch(action, 100)
      self.quantity_mode ||= 'EXACT'
      self.execution_strategy ||= 'STATIC'
      self.execution_urgency ||= 'NORMAL'
      self.execution_scope_id ||= risk_unit_id
      self.executed_quantity ||= BigDecimal('0')
      self.retry_count ||= 0
      self.created_at ||= Time.now.utc
      self.updated_at ||= created_at
    end

    def terminal?
      TERMINAL_STATUSES.include?(status)
    end

    def active?
      !terminal?
    end

    def position_action?
      LiquidationCommand::POSITION_ACTIONS.include?(action)
    end

    def transition_to!(new_status)
      raise InvalidTransition, "unknown liquidation status #{new_status.inspect}" unless STATUSES.include?(new_status)

      allowed = ALLOWED_TRANSITIONS.fetch(status)
      unless allowed.include?(new_status)
        raise InvalidTransition, "cannot transition task #{task_id} from #{status} to #{new_status}"
      end

      self.status = new_status
      self.updated_at = Time.now.utc
      self.completed_at = updated_at if terminal?
    end

    def snapshot
      ATTRIBUTES.each_with_object({}) do |name, result|
        value = public_send(name)
        result[name] = value.is_a?(BigDecimal) ? value.to_s('F') : value
      end
    end

    private

    def normalize_value(name, value)
      return nil if value.nil?
      return BigDecimal(value.to_s) if DECIMAL_FIELDS.include?(name)
      if %i[expire_at created_at updated_at completed_at next_retry_at claim_expires_at].include?(name) && value.is_a?(String)
        return Time.parse(value).utc
      end

      value
    end
  end
end
