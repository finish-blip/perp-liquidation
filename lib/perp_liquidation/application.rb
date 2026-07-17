# frozen_string_literal: true

require 'bigdecimal'
require 'uri'

module PerpLiquidation
  class Application
    REAL_REQUIRED_ENV = %w[
      DATABASE_URL REDIS_URL ORDER_SERVICE_URL POSITION_SERVICE_URL
      ACCOUNT_SERVICE_URL RISK_SERVICE_URL APPROVAL_SERVICE_URL SERVICE_TOKEN
    ].freeze
    MARKET_DATA_PROVIDERS = %w[internal binance].freeze
    ROLES = %i[all api liquidation_worker recovery_worker loss_mitigation_worker
               outbox_dispatcher event_stream_consumer].freeze
    DEFAULT_POOL_SIZES = {
      all: 10, api: 10, liquidation_worker: 2, recovery_worker: 2,
      loss_mitigation_worker: 2, outbox_dispatcher: 2, event_stream_consumer: 2
    }.freeze

    def initialize(env: ENV, role: :all)
      @env = env
      @role = role.to_sym
      raise InvalidCommand, "unsupported application role #{@role.inspect}" unless ROLES.include?(@role)

      @data_mode = @env.fetch('DATA_MODE', 'real')
      validate_configuration!
    end

    def metrics
      @metrics ||= build_metrics_registry
    end

    def repository
      @repository ||= build_repository
    end

    def command_receiver
      @command_receiver ||= CommandReceiver.new(repository: repository, metrics: metrics)
    end

    def portfolio_plan_coordinator
      @portfolio_plan_coordinator ||= PortfolioPlanCoordinator.new(repository: repository)
    end

    def order_client
      @order_client ||= build_order_client
    end

    def position_client
      @position_client ||= build_position_client
    end

    def account_client
      @account_client ||= build_account_client
    end

    def market_data_client
      @market_data_client ||= build_market_data_client
    end

    def loss_mitigation_client
      @loss_mitigation_client ||= build_loss_mitigation_client
    end

    def approval_client
      @approval_client ||= build_approval_client
    end

    def portfolio_plan_receiver
      @portfolio_plan_receiver ||= PortfolioPlanReceiver.new(
        repository: repository,
        account_client: account_client,
        coordinator: portfolio_plan_coordinator,
        metrics: metrics
      )
    end

    def orchestrator
      return @orchestrator if @orchestrator

      @orchestrator = Orchestrator.new(
        repository: repository,
        order_client: order_client,
        position_client: position_client,
        market_data_client: market_data_client,
        portfolio_plan_coordinator: portfolio_plan_coordinator,
        risk_unit_lock_manager: build_lock_manager,
        loss_mitigation_client: loss_mitigation_client,
        risk_unit_lease_seconds: Float(@env.fetch('RISK_UNIT_LOCK_TTL_SECONDS', '30')),
        max_active_orders_per_symbol: Integer(@env.fetch('SYMBOL_ACTIVE_ORDER_LIMIT', '100')),
        execution_defer_seconds: Float(@env.fetch('EXECUTION_DEFER_SECONDS', '2'))
      )
      @orchestrator.metrics = metrics
      @orchestrator
    end

    def liquidation_worker
      @liquidation_worker ||= Workers::LiquidationWorker.new(
        repository: repository,
        orchestrator: orchestrator,
        priority_aging_seconds: Float(@env.fetch('PRIORITY_AGING_SECONDS', '30'))
      )
    end

    def reconciliation_worker
      return @reconciliation_worker if @reconciliation_worker

      @reconciliation_worker = Workers::ReconciliationWorker.new(
        repository: repository, orchestrator: orchestrator, position_client: position_client
      )
      @reconciliation_worker.metrics = metrics
      @reconciliation_worker
    end

    def recovery_worker
      @recovery_worker ||= Workers::RecoveryWorker.new(reconciliation_worker: reconciliation_worker)
    end

    def operator_action_service
      @operator_action_service ||= OperatorActionService.new(
        repository: repository,
        portfolio_plan_receiver: portfolio_plan_receiver,
        reconciliation_worker: reconciliation_worker,
        approval_client: approval_client
      )
    end

    def loss_mitigation_worker
      @loss_mitigation_worker ||= Workers::LossMitigationWorker.new(
        repository: repository, orchestrator: orchestrator
      )
    end

    def outbox_dispatcher
      return @outbox_dispatcher if @outbox_dispatcher

      @outbox_dispatcher = Workers::OutboxDispatcher.new(
        repository: repository,
        publisher: build_result_publisher,
        max_attempts: Integer(@env.fetch('OUTBOX_MAX_ATTEMPTS', '10')),
        base_delay_seconds: Float(@env.fetch('OUTBOX_BASE_DELAY_SECONDS', '1'))
      )
      @outbox_dispatcher.metrics = metrics
      @outbox_dispatcher
    end

    def event_stream_consumer
      return @event_stream_consumer if defined?(@event_stream_consumer)

      @event_stream_consumer = build_event_stream_consumer
    end

    def rack_app
      API::RackApp.new(
        repository: repository,
        command_receiver: command_receiver,
        portfolio_plan_receiver: portfolio_plan_receiver,
        operator_action_service: operator_action_service,
        orchestrator: orchestrator,
        reconciliation_worker: reconciliation_worker,
        metrics: metrics,
        service_token: real_mode? ? @env.fetch('SERVICE_TOKEN') : nil
      )
    end

    private

    def build_repository
      return MemoryRepository.new unless real_mode?

      require 'mysql2'
      uri = URI.parse(@env.fetch('DATABASE_URL'))
      connection_options = {
        host: uri.host,
        port: uri.port || 3306,
        username: uri.user,
        password: uri.password,
        database: uri.path.sub(%r{\A/}, ''),
        reconnect: true,
        symbolize_keys: false,
        connect_timeout: Integer(@env.fetch('DATABASE_CONNECT_TIMEOUT_SECONDS', '5')),
        read_timeout: Integer(@env.fetch('DATABASE_READ_TIMEOUT_SECONDS', '5')),
        write_timeout: Integer(@env.fetch('DATABASE_WRITE_TIMEOUT_SECONDS', '5'))
      }
      pool_size = database_pool_size
      raise InvalidCommand, 'DATABASE_POOL_SIZE must be at least 2 in real mode' if pool_size < 2

      pool = MysqlConnectionPool.new(
        size: pool_size,
        checkout_timeout: Float(@env.fetch('DATABASE_POOL_TIMEOUT_SECONDS', '5'))
      ) do
        Mysql2::Client.new(connection_options)
      end
      MysqlRepository.new(connection_pool: pool)
    end

    def build_metrics_registry
      return MetricsRegistry.new unless real_mode?

      require 'redis'
      RedisMetricsRegistry.new(redis: Redis.new(url: @env.fetch('REDIS_URL')))
    end

    def build_order_client
      return FakeOrderClient.new unless real_mode?

      OrderHttpClient.new(
        endpoint: @env.fetch('ORDER_SERVICE_URL'),
        token: @env['SERVICE_TOKEN'],
        **http_timeout_options
      )
    end

    def build_position_client
      return FakePositionClient.new unless real_mode?

      PositionHttpClient.new(
        endpoint: @env.fetch('POSITION_SERVICE_URL'),
        token: @env['SERVICE_TOKEN'],
        **http_timeout_options
      )
    end

    def build_account_client
      unless real_mode?
        return FakeAccountClient.new([
          AccountSnapshot.new(
            account_id: 'acc_1001', user_id: '1001', version: 88,
            margin_mode: 'CROSS', settlement_currency: 'USDT'
          )
        ])
      end

      AccountHttpClient.new(
        endpoint: @env.fetch('ACCOUNT_SERVICE_URL'),
        token: @env['SERVICE_TOKEN'],
        **http_timeout_options
      )
    end

    def build_loss_mitigation_client
      return FakeLossMitigationClient.new unless real_mode?

      LossMitigationHttpClient.new(
        endpoint: @env.fetch('LOSS_MITIGATION_SERVICE_URL', @env.fetch('RISK_SERVICE_URL')),
        token: @env['SERVICE_TOKEN'],
        **http_timeout_options
      )
    end

    def build_approval_client
      return FakeApprovalClient.new unless real_mode?

      ApprovalHttpClient.new(
        endpoint: @env.fetch('APPROVAL_SERVICE_URL'),
        token: @env['SERVICE_TOKEN'],
        **http_timeout_options
      )
    end

    def build_market_data_client
      return FakeMarketDataClient.new unless real_mode?

      execution_client = build_execution_market_data_client
      return execution_client unless binance_reference_enabled?

      ReferenceCheckedMarketDataClient.new(
        execution_client: execution_client,
        reference_client: build_binance_market_data_client(
          depth_limit: Integer(@env.fetch('BINANCE_REFERENCE_DEPTH_LIMIT', '5'))
        ),
        max_deviation: @env.fetch('BINANCE_REFERENCE_MAX_DEVIATION', '0.03'),
        max_age_ms: @env.fetch('BINANCE_REFERENCE_MAX_AGE_MS', '2000')
      )
    end

    def build_execution_market_data_client
      if market_data_provider == 'binance'
        return build_binance_market_data_client
      end

      MarketDataHttpClient.new(
        endpoint: @env.fetch('MARKET_DATA_SERVICE_URL'), token: @env['SERVICE_TOKEN'], **http_timeout_options
      )
    end

    def build_binance_market_data_client(depth_limit: nil)
      BinanceFuturesMarketDataClient.new(
        endpoint: @env.fetch('BINANCE_FUTURES_URL', BinanceFuturesMarketDataClient::DEFAULT_ENDPOINT),
        depth_limit: depth_limit || Integer(@env.fetch('BINANCE_DEPTH_LIMIT', '20')),
        exchange_info_ttl: Float(@env.fetch('BINANCE_EXCHANGE_INFO_TTL_SECONDS', '3600')),
        **http_timeout_options
      )
    end

    def build_lock_manager
      return RiskUnitLockManager.new unless real_mode?

      require 'redis'
      RedisLockClient.new(
        redis: Redis.new(url: @env.fetch('REDIS_URL')),
        ttl_seconds: Float(@env.fetch('RISK_UNIT_LOCK_TTL_SECONDS', '30')),
        renewal_interval_seconds: Float(@env.fetch('RISK_UNIT_LOCK_RENEWAL_SECONDS', '10'))
      )
    end

    def build_result_publisher
      return MemoryEventPublisher.new unless real_mode?

      if @env.fetch('RESULT_TRANSPORT', 'http') == 'redis_streams'
        require 'redis'
        return Messaging::RedisStreamPublisher.new(redis: Redis.new(url: @env.fetch('REDIS_URL')))
      end

      RiskResultHttpPublisher.new(
        endpoint: @env.fetch('RISK_SERVICE_URL'),
        token: @env['SERVICE_TOKEN'],
        **http_timeout_options
      )
    end

    def build_event_stream_consumer
      return nil unless real_mode? && @env.fetch('EVENT_STREAMS_ENABLED', 'false') == 'true'

      require 'redis'
      router = Messaging::EventRouter.new(
        command_receiver: command_receiver,
        portfolio_plan_receiver: portfolio_plan_receiver,
        orchestrator: orchestrator,
        reconciliation_worker: reconciliation_worker,
        operator_action_service: operator_action_service
      )
      router.repository = repository
      Messaging::RedisStreamConsumer.new(
        redis: Redis.new(url: @env.fetch('REDIS_URL')),
        router: router,
        topics: Messaging::EventRouter::TOPICS,
        group: @env.fetch('EVENT_STREAM_GROUP', 'perp-liquidation'),
        consumer: @env.fetch('EVENT_STREAM_CONSUMER', 'perp-liquidation-1'),
        max_delivery_attempts: Integer(@env.fetch('EVENT_STREAM_MAX_ATTEMPTS', '5')),
        claim_idle_ms: Integer(@env.fetch('EVENT_STREAM_CLAIM_IDLE_MS', '30000'))
      )
    end

    def blank?(value)
      value.nil? || value.empty?
    end

    def database_pool_size
      role_variable = %i[all api].include?(@role) ? 'DATABASE_POOL_SIZE_API' : 'DATABASE_POOL_SIZE_BACKGROUND'
      configured = @env[role_variable] || @env['DATABASE_POOL_SIZE'] || DEFAULT_POOL_SIZES.fetch(@role)
      Integer(configured)
    end

    def http_timeout_options
      {
        open_timeout: Float(@env.fetch('HTTP_OPEN_TIMEOUT_SECONDS', '2')),
        timeout: Float(@env.fetch('HTTP_READ_TIMEOUT_SECONDS', '5'))
      }
    end

    def real_mode?
      @data_mode == 'real'
    end

    def market_data_provider
      @env.fetch('MARKET_DATA_PROVIDER', 'internal')
    end

    def binance_reference_enabled?
      boolean_environment_value('BINANCE_REFERENCE_ENABLED', default: false)
    end

    def boolean_environment_value(name, default:)
      value = @env.fetch(name, default.to_s).to_s.downcase
      return true if value == 'true'
      return false if value == 'false'

      raise InvalidCommand, "#{name} must be true or false"
    end

    def validate_configuration!
      return if @data_mode == 'memory'
      raise InvalidCommand, "unsupported DATA_MODE #{@data_mode.inspect}" unless real_mode?
      unless MARKET_DATA_PROVIDERS.include?(market_data_provider)
        raise InvalidCommand, "unsupported MARKET_DATA_PROVIDER #{market_data_provider.inspect}"
      end
      if market_data_provider == 'binance'
        unless boolean_environment_value('ALLOW_BINANCE_AS_EXECUTION_MARKET_DATA', default: false)
          raise InvalidCommand,
                'MARKET_DATA_PROVIDER=binance requires ALLOW_BINANCE_AS_EXECUTION_MARKET_DATA=true'
        end
        if binance_reference_enabled?
          raise InvalidCommand, 'BINANCE_REFERENCE_ENABLED cannot be used when MARKET_DATA_PROVIDER=binance'
        end
      else
        validate_binance_reference_configuration! if binance_reference_enabled?
      end

      required = REAL_REQUIRED_ENV.dup
      required << 'MARKET_DATA_SERVICE_URL' if market_data_provider == 'internal'
      missing = required.select { |name| blank?(@env[name]) }
      return if missing.empty?

      raise InvalidCommand, "real data mode requires: #{missing.join(', ')}"
    end

    def validate_binance_reference_configuration!
      deviation = BigDecimal(@env.fetch('BINANCE_REFERENCE_MAX_DEVIATION', '0.03').to_s)
      age_ms = Integer(@env.fetch('BINANCE_REFERENCE_MAX_AGE_MS', '2000'))
      unless deviation.positive? && deviation < 1
        raise InvalidCommand, 'BINANCE_REFERENCE_MAX_DEVIATION must be between 0 and 1'
      end
      unless age_ms.between?(1, 60_000)
        raise InvalidCommand, 'BINANCE_REFERENCE_MAX_AGE_MS must be between 1 and 60000'
      end
    rescue ArgumentError, TypeError => e
      raise InvalidCommand, "invalid Binance reference market data configuration: #{e.message}"
    end
  end
end
