# frozen_string_literal: true

require 'bigdecimal'
require 'faraday'
require 'json'
require 'mysql2'
require 'time'
require 'uri'

module PerpLiquidation
  module Integration
    class ReferenceServicesApp
      def initialize(env: ENV)
        @env = env
        @token = env.fetch('SERVICE_TOKEN')
        @liquidation_url = env.fetch('LIQUIDATION_URL')
        @connection = build_connection(env.fetch('DATABASE_URL'))
        @market_quotes = {}
      end

      def call(env)
        method = env['REQUEST_METHOD']
        path = env['PATH_INFO'].to_s
        return json(200, status: 'ok', service: 'perp-liquidation-reference-services') if method == 'GET' && path == '/health'
        return json(401, error: 'unauthorized') unless env['HTTP_AUTHORIZATION'] == "Bearer #{@token}"

        return find_market_quote(path) if method == 'GET' && path.match?(%r{\A/api/v1/internal/market/quotes/[^/]+\z})
        if method == 'POST' && path.match?(%r{\A/api/v1/internal/integration/market/quotes/[^/]+\z})
          return configure_market_quote(env, path)
        end
        return find_position(path) if method == 'GET' && path.match?(%r{\A/api/v1/internal/positions/[^/]+\z})
        if method == 'GET' && path.match?(%r{\A/api/v1/internal/accounts/[^/]+/liquidation-state\z})
          return find_account(path)
        end
        if method == 'GET' && path.match?(%r{\A/api/v1/internal/positions/settlements/by-order-id/[^/]+\z})
          return find_settlement(path)
        end
        return reset_position(env, path) if method == 'POST' && path.match?(%r{\A/api/v1/internal/integration/positions/[^/]+/reset\z})
        if method == 'POST' && path.match?(%r{\A/api/v1/internal/integration/accounts/[^/]+/reset\z})
          return reset_account(env, path)
        end
        return submit_order(env) if method == 'POST' && path == '/api/v1/internal/orders/liquidation'
        if method == 'POST' && path.match?(%r{\A/api/v1/internal/orders/liquidation/[^/]+/cancel\z})
          return cancel_liquidation_order(env, path)
        end
        return cancel_orders(env) if method == 'POST' && path == '/api/v1/internal/orders/cancel-risk'
        return find_order(path) if method == 'GET' && path.match?(%r{\A/api/v1/internal/orders/by-client-order-id/[^/]+\z})
        return fill_order(env, path) if method == 'POST' && path.match?(%r{\A/api/v1/internal/integration/orders/[^/]+/fill\z})
        return receive_risk_result(env) if method == 'POST' && path == '/api/v1/internal/risk/liquidation-results'
        return list_risk_results if method == 'GET' && path == '/api/v1/internal/integration/risk-results'
        return verify_approval(env) if method == 'POST' && path == '/api/v1/internal/approvals/verify'
        return check_bankruptcy(env) if method == 'POST' && path == '/api/v1/internal/bankruptcy/checks'
        return claim_insurance(env) if method == 'POST' && path == '/api/v1/internal/insurance/claims'
        return request_adl(env) if method == 'POST' && path == '/api/v1/internal/adl/requests'
        return find_adl(path) if method == 'GET' && path.match?(%r{\A/api/v1/internal/adl/requests/[^/]+\z})
        return configure_loss_policy(env) if method == 'POST' && path == '/api/v1/internal/integration/loss-policy'
        if method == 'POST' && path.match?(%r{\A/api/v1/internal/integration/adl/[^/]+/complete\z})
          return complete_adl(path)
        end

        json(404, error: 'not_found')
      rescue KeyError, ArgumentError, JSON::ParserError => e
        json(422, error: 'invalid_request', message: e.message)
      rescue StandardError => e
        json(500, error: 'internal_error', message: e.message)
      end

      private

      def build_connection(database_url)
        uri = URI.parse(database_url)
        Mysql2::Client.new(
          host: uri.host, port: uri.port || 3306, username: uri.user,
          password: uri.password, database: uri.path.sub(%r{\A/}, ''),
          reconnect: true, symbolize_keys: false
        )
      end

      def find_position(path)
        position_id = URI.decode_www_form_component(path.split('/').last)
        row = first("SELECT * FROM integration_positions WHERE position_id = #{quote(position_id)}")
        return json(404, error: 'position_not_found') unless row

        json(200, data: position_payload(row))
      end

      def find_market_quote(path)
        symbol = URI.decode_www_form_component(path.split('/').last)
        quote = market_quote(symbol)
        json(200, data: quote)
      end

      def find_account(path)
        account_id = URI.decode_www_form_component(path.split('/')[-2])
        row = first("SELECT * FROM integration_accounts WHERE account_id = #{quote(account_id)}")
        return json(404, error: 'account_not_found') unless row

        json(200, data: account_payload(row))
      end

      def configure_market_quote(env, path)
        symbol = URI.decode_www_form_component(path.split('/').last)
        body = parse_body(env)
        best_bid = BigDecimal(body.fetch('best_bid').to_s).to_s('F')
        best_ask = BigDecimal(body.fetch('best_ask').to_s).to_s('F')
        @market_quotes[symbol] = {
          symbol: symbol,
          best_bid: best_bid,
          best_ask: best_ask,
          observed_at: body.fetch('observed_at', Time.now.utc.iso8601),
          sequence: Integer(body.fetch('sequence', (Time.now.utc.to_f * 1_000_000).to_i)),
          bids: normalize_book_levels(body['bids'] || [{ price: best_bid, quantity: '1' }]),
          asks: normalize_book_levels(body['asks'] || [{ price: best_ask, quantity: '1' }]),
          quantity_increment: BigDecimal(body.fetch('quantity_increment', '0.00000001').to_s).to_s('F')
        }
        json(200, data: @market_quotes[symbol])
      end

      def reset_position(env, path)
        position_id = URI.decode_www_form_component(path.split('/')[-2])
        body = parse_body(env)
        now = Time.now.utc
        execute(<<~SQL)
          UPDATE integration_positions
          SET version = version + 1, size = #{quote(BigDecimal(body.fetch('size').to_s))}, updated_at = #{quote(now)}
          WHERE position_id = #{quote(position_id)}
        SQL
        find_position("/api/v1/internal/positions/#{position_id}")
      end

      def reset_account(env, path)
        account_id = URI.decode_www_form_component(path.split('/')[-2])
        body = parse_body(env)
        execute(<<~SQL)
          UPDATE integration_accounts
          SET version = #{quote(Integer(body.fetch('version')))}, updated_at = #{quote(Time.now.utc)}
          WHERE account_id = #{quote(account_id)}
        SQL
        find_account("/api/v1/internal/accounts/#{account_id}/liquidation-state")
      end

      def find_settlement(path)
        order_id = URI.decode_www_form_component(path.split('/').last)
        order = first("SELECT * FROM integration_orders WHERE order_id = #{quote(order_id)}")
        return json(404, error: 'settlement_not_found') unless order

        filled_quantity = BigDecimal(value(order, 'filled_quantity').to_s)
        settled = value(order, 'status') == 'FILLED' ||
                  (%w[CANCELLED REJECTED].include?(value(order, 'status')) && filled_quantity.positive?)
        position = first("SELECT * FROM integration_positions WHERE position_id = #{quote(value(order, 'position_id'))}")
        account = first("SELECT * FROM integration_accounts WHERE account_id = #{quote(value(position, 'account_id'))}")
        version = settled ? Integer(value(position, 'version')) : nil
        json(200, data: {
          order_id: order_id, position_id: value(order, 'position_id'),
          settled: settled, position_version: version,
          account_version: settled && account ? Integer(value(account, 'version')) : nil
        })
      end

      def submit_order(env)
        body = parse_body(env)
        existing = first("SELECT * FROM integration_orders WHERE client_order_id = #{quote(body.fetch('client_order_id'))}")
        return json(200, data: order_payload(existing)) if existing

        transaction do
          position = first(<<~SQL)
            SELECT * FROM integration_positions
            WHERE position_id = #{quote(body.fetch('position_id'))}
            FOR UPDATE
          SQL
          raise ArgumentError, 'position not found' unless position
          raise ArgumentError, 'reduce_only must be true' unless body['reduce_only'] == true
          unless Integer(value(position, 'version')) == Integer(body.fetch('expected_position_version'))
            raise ArgumentError, 'position version mismatch'
          end
          if body['portfolio_plan_id']
            account = first(<<~SQL)
              SELECT * FROM integration_accounts
              WHERE account_id = #{quote(value(position, 'account_id'))}
              FOR UPDATE
            SQL
            raise ArgumentError, 'portfolio account not found' unless account
            unless Integer(value(account, 'version')) == Integer(body.fetch('expected_account_version'))
              raise ArgumentError, 'account version mismatch'
            end
            authorized_notional = BigDecimal(body.fetch('authorized_notional').to_s)
            notional_reference_price = BigDecimal(body.fetch('notional_reference_price').to_s)
            unless authorized_notional.positive? && notional_reference_price.positive?
              raise ArgumentError, 'portfolio notional authorization must be positive'
            end
            if BigDecimal(body.fetch('quantity').to_s) * notional_reference_price > authorized_notional
              raise ArgumentError, 'order exceeds authorized_notional'
            end
          end

          quantity = BigDecimal(body.fetch('quantity').to_s)
          raise ArgumentError, 'quantity exceeds position size' if quantity > BigDecimal(value(position, 'size').to_s)
          enforce_submission_price_protection!(body)
          enforce_adaptive_execution!(body, quantity)
          accept_fencing_token!(body.fetch('risk_unit_id'), Integer(body.fetch('fencing_token')))

          order_id = "ord_#{body.fetch('client_order_id')}"
          now = Time.now.utc
          execute(<<~SQL)
            INSERT INTO integration_orders
              (order_id, client_order_id, task_id, risk_decision_id, risk_unit_id,
               position_id, expected_position_version, fencing_token, side, quantity,
               status, request_payload, created_at, updated_at)
            VALUES
              (#{quote(order_id)}, #{quote(body.fetch('client_order_id'))}, #{quote(body.fetch('task_id'))},
               #{quote(body.fetch('risk_decision_id'))}, #{quote(body.fetch('risk_unit_id'))},
               #{quote(body.fetch('position_id'))}, #{quote(body.fetch('expected_position_version'))},
               #{quote(body.fetch('fencing_token'))}, #{quote(body.fetch('side'))}, #{quote(quantity)},
               'ACCEPTED', #{quote(JSON.generate(body))}, #{quote(now)}, #{quote(now)})
          SQL
        end
        row = first("SELECT * FROM integration_orders WHERE client_order_id = #{quote(body.fetch('client_order_id'))}")
        json(202, data: order_payload(row))
      end

      def accept_fencing_token!(risk_unit_id, token)
        row = first("SELECT * FROM integration_fencing_tokens WHERE risk_unit_id = #{quote(risk_unit_id)} FOR UPDATE")
        raise ArgumentError, 'stale fencing token' if row && token < Integer(value(row, 'latest_token'))

        execute(<<~SQL)
          INSERT INTO integration_fencing_tokens (risk_unit_id, latest_token, updated_at)
          VALUES (#{quote(risk_unit_id)}, #{quote(token)}, #{quote(Time.now.utc)})
          ON DUPLICATE KEY UPDATE latest_token = GREATEST(latest_token, VALUES(latest_token)), updated_at = VALUES(updated_at)
        SQL
      end

      def cancel_orders(env)
        body = parse_body(env)
        execute(<<~SQL)
          INSERT INTO integration_cancellations (task_id, risk_decision_id, user_id, symbol, created_at)
          VALUES (#{quote(body.fetch('task_id'))}, #{quote(body.fetch('risk_decision_id'))},
                  #{quote(body.fetch('user_id'))}, #{quote(body.fetch('symbol'))}, #{quote(Time.now.utc)})
          ON DUPLICATE KEY UPDATE task_id = task_id
        SQL
        json(200, data: { status: 'CANCELLED', cancelled_order_ids: [] })
      end

      def cancel_liquidation_order(env, path)
        client_order_id = URI.decode_www_form_component(path.split('/')[-2])
        body = parse_body(env)
        transaction do
          order = first(<<~SQL)
            SELECT * FROM integration_orders
            WHERE client_order_id = #{quote(client_order_id)}
            FOR UPDATE
          SQL
          raise ArgumentError, 'order not found' unless order
          raise ArgumentError, 'task does not own order' unless value(order, 'task_id').to_s == body.fetch('task_id').to_s
          unless value(order, 'risk_decision_id').to_s == body.fetch('risk_decision_id').to_s
            raise ArgumentError, 'risk decision does not own order'
          end
          unless Integer(value(order, 'fencing_token')) == Integer(body.fetch('fencing_token'))
            raise ArgumentError, 'fencing token does not own order'
          end
          unless value(order, 'status') == 'FILLED'
            execute(<<~SQL)
              UPDATE integration_orders
              SET status = 'CANCELLED', updated_at = #{quote(Time.now.utc)}
              WHERE client_order_id = #{quote(client_order_id)}
            SQL
          end
        end
        order = first("SELECT * FROM integration_orders WHERE client_order_id = #{quote(client_order_id)}")
        json(200, data: order_payload(order))
      end

      def find_order(path)
        client_order_id = URI.decode_www_form_component(path.split('/').last)
        row = first("SELECT * FROM integration_orders WHERE client_order_id = #{quote(client_order_id)}")
        return json(404, error: 'order_not_found') unless row

        json(200, data: order_payload(row))
      end

      def fill_order(env, path)
        order_id = URI.decode_www_form_component(path.split('/')[-2])
        body = parse_body(env)
        requested_status = body.fetch('status', 'FILLED')
        unless %w[PARTIALLY_FILLED FILLED].include?(requested_status)
          raise ArgumentError, 'fill status must be PARTIALLY_FILLED or FILLED'
        end
        transaction do
          order = first("SELECT * FROM integration_orders WHERE order_id = #{quote(order_id)} FOR UPDATE")
          raise ArgumentError, 'order not found' unless order
          unless value(order, 'status') == 'FILLED'
            raise ArgumentError, 'cancelled order cannot be filled' if value(order, 'status') == 'CANCELLED'

            position = first("SELECT * FROM integration_positions WHERE position_id = #{quote(value(order, 'position_id'))} FOR UPDATE")
            requested_quantity = BigDecimal(value(order, 'quantity').to_s)
            current_filled = BigDecimal(value(order, 'filled_quantity').to_s)
            target_filled = if body['filled_quantity']
                              BigDecimal(body['filled_quantity'].to_s)
                            elsif requested_status == 'FILLED'
                              requested_quantity
                            else
                              raise ArgumentError, 'partial fill requires filled_quantity'
                            end
            if target_filled < current_filled || target_filled > requested_quantity
              raise ArgumentError, 'filled quantity is not cumulative or exceeds requested quantity'
            end
            if requested_status == 'PARTIALLY_FILLED' && (!target_filled.positive? || target_filled >= requested_quantity)
              raise ArgumentError, 'partial fill quantity must be between zero and requested quantity'
            end
            if requested_status == 'FILLED' && target_filled != requested_quantity
              raise ArgumentError, 'filled order must reach requested quantity'
            end
            fill_delta = target_filled - current_filled
            request_payload = JSON.parse(value(order, 'request_payload').to_s)
            enforce_fill_price_protection!(request_payload, BigDecimal(body.fetch('average_price').to_s))
            next_size = BigDecimal(value(position, 'size').to_s) - fill_delta
            raise ArgumentError, 'position size would become negative' if next_size.negative?

            if fill_delta.positive?
              execute(<<~SQL)
                UPDATE integration_positions
                SET size = #{quote(next_size)}, version = version + 1, updated_at = #{quote(Time.now.utc)}
                WHERE position_id = #{quote(value(order, 'position_id'))}
              SQL
              if request_payload['portfolio_plan_id']
                execute(<<~SQL)
                  UPDATE integration_accounts
                  SET version = version + 1, updated_at = #{quote(Time.now.utc)}
                  WHERE account_id = #{quote(value(position, 'account_id'))}
                SQL
              end
            end
            execute(<<~SQL)
              UPDATE integration_orders
              SET status = #{quote(requested_status)}, filled_quantity = #{quote(target_filled)},
                  average_price = #{quote(BigDecimal(body.fetch('average_price').to_s))},
                  fee = #{quote(BigDecimal(body.fetch('fee', '0').to_s))}, updated_at = #{quote(Time.now.utc)}
              WHERE order_id = #{quote(order_id)}
            SQL
          end
        end

        order = first("SELECT * FROM integration_orders WHERE order_id = #{quote(order_id)}")
        position = first("SELECT * FROM integration_positions WHERE position_id = #{quote(value(order, 'position_id'))}")
        account = first("SELECT * FROM integration_accounts WHERE account_id = #{quote(value(position, 'account_id'))}")
        if body.fetch('publish_order_event', true)
          event_sequence = Integer(body.fetch('order_event_sequence', requested_status == 'FILLED' ? 1 : 1))
          publish_liquidation_event('/api/v1/internal/liquidation/events/orders', {
            event_id: "order_#{requested_status.downcase}_#{order_id}_#{event_sequence}", order_id: order_id,
            client_order_id: value(order, 'client_order_id'), status: requested_status,
            order_event_sequence: event_sequence,
            filled_quantity: decimal(value(order, 'filled_quantity')),
            average_price: decimal(value(order, 'average_price')), fee: decimal(value(order, 'fee'))
          })
        end
        if requested_status == 'FILLED' && body.fetch('publish_settlement_event', true)
          publish_liquidation_event('/api/v1/internal/liquidation/events/settlements', {
            event_id: "settled_#{order_id}", task_id: value(order, 'task_id'), order_id: order_id,
            position_id: value(order, 'position_id'), position_version: Integer(value(position, 'version')),
            account_version: account && Integer(value(account, 'version'))
          })
        end
        json(200, data: order_payload(order), position: position_payload(position))
      end

      def publish_liquidation_event(path, payload)
        response = Faraday.post("#{@liquidation_url}#{path}") do |request|
          request.headers['Authorization'] = "Bearer #{@token}"
          request.headers['Content-Type'] = 'application/json'
          request.body = JSON.generate(payload)
        end
        raise "liquidation callback failed: #{response.status} #{response.body}" if response.status >= 300
      end

      def market_quote(symbol)
        @market_quotes[symbol] || {
          symbol: symbol,
          best_bid: '54190',
          best_ask: '54210',
          observed_at: Time.now.utc.iso8601,
          sequence: (Time.now.utc.to_f * 1_000_000).to_i,
          bids: [{ price: '54190', quantity: '1' }],
          asks: [{ price: '54210', quantity: '1' }],
          quantity_increment: '0.00000001'
        }
      end

      def normalize_book_levels(levels)
        raise ArgumentError, 'book levels must be an array' unless levels.is_a?(Array)

        levels.map do |level|
          price = level['price'] || level[:price]
          quantity = level['quantity'] || level[:quantity]
          {
            price: BigDecimal(price.to_s).to_s('F'),
            quantity: BigDecimal(quantity.to_s).to_s('F')
          }
        end
      end

      def enforce_submission_price_protection!(request)
        return unless request['worst_acceptable_price']

        quote = market_quote(request.fetch('symbol'))
        market_price = request.fetch('side') == 'SELL' ? quote[:best_bid] : quote[:best_ask]
        enforce_price_boundary!(request, BigDecimal(market_price.to_s))
      end

      def enforce_adaptive_execution!(request, quantity)
        return unless request['execution_strategy'] == 'ADAPTIVE'

        quote = market_quote(request.fetch('symbol'))
        boundary = BigDecimal(request.fetch('worst_acceptable_price').to_s)
        side = request.fetch('side')
        levels = side == 'SELL' ? quote[:bids] : quote[:asks]
        depth = levels.reduce(BigDecimal('0')) do |total, level|
          price = BigDecimal((level[:price] || level['price']).to_s)
          level_quantity = BigDecimal((level[:quantity] || level['quantity']).to_s)
          eligible = side == 'SELL' ? price >= boundary : price <= boundary
          eligible ? total + level_quantity : total
        end
        participation = BigDecimal(request.fetch('max_book_participation').to_s)
        raise ArgumentError, 'child order exceeds current protected market depth' if quantity > depth * participation

        increment = BigDecimal(request.fetch('quantity_increment').to_s)
        raise ArgumentError, 'child order quantity is off increment' unless (quantity % increment).zero?
        if request.fetch('type') == 'LIMIT'
          limit_price = BigDecimal(request.fetch('limit_price').to_s)
          raise ArgumentError, 'adaptive limit price must equal protected boundary' unless limit_price == boundary
        end
      end

      def enforce_fill_price_protection!(request, execution_price)
        return unless request['worst_acceptable_price']

        enforce_price_boundary!(request, execution_price)
      end

      def enforce_price_boundary!(request, price)
        boundary = BigDecimal(request.fetch('worst_acceptable_price').to_s)
        bankruptcy_price = BigDecimal(request.fetch('bankruptcy_price').to_s)
        deviation = BigDecimal(request.fetch('max_liquidation_deviation').to_s)
        expected_boundary = if request.fetch('side') == 'SELL'
                              bankruptcy_price * (BigDecimal('1') - deviation)
                            else
                              bankruptcy_price * (BigDecimal('1') + deviation)
                            end
        raise ArgumentError, 'worst_acceptable_price does not match authorized boundary' unless boundary == expected_boundary

        if request.fetch('side') == 'SELL' && price < boundary
          raise ArgumentError, 'execution price is below worst_acceptable_price'
        end
        if request.fetch('side') == 'BUY' && price > boundary
          raise ArgumentError, 'execution price is above worst_acceptable_price'
        end
      end

      def receive_risk_result(env)
        body = parse_body(env)
        event_id = env['HTTP_IDEMPOTENCY_KEY'].to_s.empty? ? body.fetch('event_id') : env['HTTP_IDEMPOTENCY_KEY']
        execute(<<~SQL)
          INSERT INTO integration_risk_results (event_id, topic, payload, created_at)
          VALUES (#{quote(event_id)}, #{quote(body.fetch('topic'))}, #{quote(JSON.generate(body.fetch('data')))}, #{quote(Time.now.utc)})
          ON DUPLICATE KEY UPDATE event_id = event_id
        SQL
        json(202, status: 'accepted', event_id: event_id)
      end

      def check_bankruptcy(env)
        body = parse_body(env)
        task_id = body.fetch('task_id')
        existing = first("SELECT * FROM integration_bankruptcy_checks WHERE task_id = #{quote(task_id)}")
        unless existing
          policy = first('SELECT * FROM integration_loss_policy WHERE id = 1')
          execute(<<~SQL)
            INSERT INTO integration_bankruptcy_checks
              (task_id, check_id, bankruptcy_price, bankruptcy_loss, currency, created_at)
            VALUES
              (#{quote(task_id)}, #{quote("bankruptcy_#{task_id}")},
               #{quote(value(policy, 'bankruptcy_price'))}, #{quote(value(policy, 'bankruptcy_loss'))},
               #{quote(value(policy, 'currency'))}, #{quote(Time.now.utc)})
          SQL
          existing = first("SELECT * FROM integration_bankruptcy_checks WHERE task_id = #{quote(task_id)}")
        end
        json(200, data: {
          check_id: value(existing, 'check_id'), status: 'COMPLETED',
          bankruptcy_price: decimal(value(existing, 'bankruptcy_price')),
          bankruptcy_loss: decimal(value(existing, 'bankruptcy_loss')),
          currency: value(existing, 'currency')
        })
      end

      def claim_insurance(env)
        body = parse_body(env)
        task_id = body.fetch('task_id')
        existing = first("SELECT * FROM integration_insurance_claims WHERE task_id = #{quote(task_id)}")
        unless existing
          policy = first('SELECT * FROM integration_loss_policy WHERE id = 1')
          requested = BigDecimal(body.fetch('requested_amount').to_s)
          ratio = BigDecimal(value(policy, 'insurance_coverage_ratio').to_s)
          covered = requested * ratio
          covered = requested if covered > requested
          execute(<<~SQL)
            INSERT INTO integration_insurance_claims
              (task_id, claim_id, requested_amount, covered_amount, currency, created_at)
            VALUES
              (#{quote(task_id)}, #{quote("insurance_#{task_id}")}, #{quote(requested)},
               #{quote(covered)}, #{quote(body.fetch('currency', 'USDT'))}, #{quote(Time.now.utc)})
          SQL
          existing = first("SELECT * FROM integration_insurance_claims WHERE task_id = #{quote(task_id)}")
        end
        json(200, data: {
          claim_id: value(existing, 'claim_id'), status: 'COMPLETED',
          requested_amount: decimal(value(existing, 'requested_amount')),
          covered_amount: decimal(value(existing, 'covered_amount')),
          currency: value(existing, 'currency')
        })
      end

      def request_adl(env)
        body = parse_body(env)
        task_id = body.fetch('task_id')
        existing = first("SELECT * FROM integration_adl_requests WHERE task_id = #{quote(task_id)}")
        unless existing
          now = Time.now.utc
          execute(<<~SQL)
            INSERT INTO integration_adl_requests
              (task_id, adl_request_id, requested_amount, covered_amount, currency, status, created_at, updated_at)
            VALUES
              (#{quote(task_id)}, #{quote("adl_#{task_id}")}, #{quote(body.fetch('requested_amount'))},
               0, #{quote(body.fetch('currency', 'USDT'))}, 'PENDING', #{quote(now)}, #{quote(now)})
          SQL
          existing = first("SELECT * FROM integration_adl_requests WHERE task_id = #{quote(task_id)}")
        end
        json(202, data: adl_payload(existing))
      end

      def find_adl(path)
        request_id = URI.decode_www_form_component(path.split('/').last)
        row = first("SELECT * FROM integration_adl_requests WHERE adl_request_id = #{quote(request_id)}")
        return json(404, error: 'adl_request_not_found') unless row

        json(200, data: adl_payload(row))
      end

      def complete_adl(path)
        request_id = URI.decode_www_form_component(path.split('/')[-2])
        execute(<<~SQL)
          UPDATE integration_adl_requests
          SET status = 'COMPLETED', covered_amount = requested_amount, updated_at = #{quote(Time.now.utc)}
          WHERE adl_request_id = #{quote(request_id)}
        SQL
        find_adl("/api/v1/internal/adl/requests/#{URI.encode_www_form_component(request_id)}")
      end

      def configure_loss_policy(env)
        body = parse_body(env)
        execute(<<~SQL)
          UPDATE integration_loss_policy
          SET bankruptcy_price = #{quote(body['bankruptcy_price'])},
              bankruptcy_loss = #{quote(body.fetch('bankruptcy_loss', '0'))},
              insurance_coverage_ratio = #{quote(body.fetch('insurance_coverage_ratio', '1'))},
              currency = #{quote(body.fetch('currency', 'USDT'))}, updated_at = #{quote(Time.now.utc)}
          WHERE id = 1
        SQL
        json(200, status: 'configured')
      end

      def adl_payload(row)
        {
          adl_request_id: value(row, 'adl_request_id'), status: value(row, 'status'),
          requested_amount: decimal(value(row, 'requested_amount')),
          covered_amount: decimal(value(row, 'covered_amount')), currency: value(row, 'currency')
        }
      end

      def list_risk_results
        data = @connection.query('SELECT * FROM integration_risk_results ORDER BY created_at DESC LIMIT 100').map do |row|
          { event_id: value(row, 'event_id'), topic: value(row, 'topic'), payload: JSON.parse(value(row, 'payload').to_s) }
        end
        json(200, data: data)
      end

      def verify_approval(env)
        body = parse_body(env)
        fields = %w[approval_id operation_id action target_type target_id operator_id approver_id]
        evidence = fields.each_with_object({}) { |field, result| result[field] = body.fetch(field) }
        raise ArgumentError, 'operator and approver must be different' if evidence['operator_id'] == evidence['approver_id']

        json(200, data: evidence.merge(
          approved: true,
          expires_at: (Time.now.utc + 300).iso8601
        ))
      end

      def position_payload(row)
        {
          position_id: value(row, 'position_id'), version: Integer(value(row, 'version')),
          user_id: value(row, 'user_id'), account_id: value(row, 'account_id'),
          symbol: value(row, 'symbol'), side: value(row, 'side'), size: decimal(value(row, 'size'))
        }
      end

      def order_payload(row)
        {
          order_id: value(row, 'order_id'), client_order_id: value(row, 'client_order_id'),
          status: value(row, 'status'), filled_quantity: decimal(value(row, 'filled_quantity')),
          average_price: decimal(value(row, 'average_price')), fee: decimal(value(row, 'fee'))
        }
      end

      def account_payload(row)
        {
          account_id: value(row, 'account_id'),
          user_id: value(row, 'user_id'),
          version: Integer(value(row, 'version')),
          margin_mode: value(row, 'margin_mode'),
          settlement_currency: value(row, 'settlement_currency')
        }
      end

      def parse_body(env)
        JSON.parse(env['rack.input'].read)
      end

      def transaction
        execute('START TRANSACTION')
        result = yield
        execute('COMMIT')
        result
      rescue StandardError
        execute('ROLLBACK')
        raise
      end

      def execute(sql)
        @connection.query(sql)
      end

      def first(sql)
        execute(sql).first
      end

      def value(row, key)
        row[key] || row[key.to_sym]
      end

      def quote(value)
        case value
        when nil then 'NULL'
        when Numeric then value.to_s
        when Time then "'#{value.utc.strftime('%Y-%m-%d %H:%M:%S.%6N')}'"
        else "'#{@connection.escape(value.to_s)}'"
        end
      end

      def decimal(value)
        value.nil? ? nil : BigDecimal(value.to_s).to_s('F')
      end

      def json(status, body)
        [status, { 'Content-Type' => 'application/json' }, [JSON.generate(body)]]
      end
    end
  end
end
