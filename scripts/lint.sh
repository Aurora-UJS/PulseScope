#!/bin/bash

# PulseScope Linting Script
echo "Running Clang-format..."
find include/ -name "*.hpp" -o -name "*.cpp" | xargs clang-format -i

echo "Running Go Lint..."
cd backend && go fmt ./...

echo "Linting complete."
