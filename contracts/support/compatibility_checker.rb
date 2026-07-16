# frozen_string_literal: true

require 'json'
require 'open3'

module PerpLiquidation
  module Contracts
    class CompatibilityChecker
      METADATA_KEYS = %w[$comment description examples title].freeze
      EXTENSION_CONTAINERS = %w[$defs definitions properties].freeze

      attr_reader :errors

      def self.compare_documents(previous, current, source = 'schema')
        checker = new
        checker.send(:compare, previous, current, [source])
        checker.errors
      end

      def initialize(root: Dir.pwd)
        @root = File.expand_path(root)
        @errors = []
      end

      def check_git_ref(base_ref)
        verify_ref!(base_ref)
        previous_paths = git('ls-tree', '-r', '--name-only', base_ref, '--', 'contracts/schemas')
                         .lines.map(&:strip).select { |path| path.end_with?('.json') }
        current_paths = Dir[File.join(@root, 'contracts', 'schemas', '*.json')]
                        .map { |path| relative_path(path) }.sort

        (previous_paths - current_paths).sort.each do |path|
          errors << "#{path}: versioned schema file was removed"
        end

        (previous_paths & current_paths).sort.each do |path|
          previous = parse_json(git('show', "#{base_ref}:#{path}"), "#{base_ref}:#{path}")
          current = parse_json(File.read(File.join(@root, path)), path)
          compare(previous, current, [path]) if previous && current
        end

        errors
      end

      private

      def compare(previous, current, path)
        if previous.class != current.class
          return incompatible(path, "changed value type from #{previous.class} to #{current.class}")
        end

        case previous
        when Hash
          compare_hash(previous, current, path)
        when Array
          incompatible(path, 'changed array value') unless previous == current
        else
          incompatible(path, "changed from #{previous.inspect} to #{current.inspect}") unless previous == current
        end
      end

      def compare_hash(previous, current, path)
        (previous.keys - current.keys).sort.each do |key|
          next if METADATA_KEYS.include?(key)

          label = path.last == 'properties' ? 'property was removed' : 'keyword was removed'
          incompatible(path + [key], label)
        end

        (current.keys - previous.keys).sort.each do |key|
          next if METADATA_KEYS.include?(key)
          next if EXTENSION_CONTAINERS.include?(path.last)

          incompatible(path + [key], 'new validation keyword was added')
        end

        (previous.keys & current.keys).sort.each do |key|
          next if METADATA_KEYS.include?(key)

          compare(previous[key], current[key], path + [key])
        end
      end

      def incompatible(path, message)
        errors << "#{format_path(path)}: #{message}"
      end

      def format_path(path)
        path.each_with_index.map { |part, index| index.zero? ? part : "/#{part}" }.join
      end

      def verify_ref!(base_ref)
        git('rev-parse', '--verify', "#{base_ref}^{commit}")
      rescue StandardError => e
        raise ArgumentError, "invalid base ref #{base_ref.inspect}: #{e.message}"
      end

      def git(*arguments)
        stdout, stderr, status = Open3.capture3(
          'git', '-c', "safe.directory=#{@root}", *arguments, chdir: @root
        )
        return stdout if status.success?

        raise "git #{arguments.first} failed: #{stderr.strip}"
      end

      def parse_json(content, source)
        JSON.parse(content)
      rescue JSON::ParserError => e
        errors << "#{source}: invalid JSON: #{e.message}"
        nil
      end

      def relative_path(path)
        normalized = path.tr('\\', '/')
        normalized.delete_prefix(@root.tr('\\', '/') + '/')
      end
    end
  end
end
